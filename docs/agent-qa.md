# Agent Q&A 技术方案

## 架构概述

Q&A 功能采用 **Agentic Search** 模式：LLM 在迭代循环中自主决定搜索策略、执行工具、评估结果充分性，直到可以生成最终回答。

循环体本身不自研：由 [`@mariozechner/pi-agent-core`](https://www.npmjs.com/package/@mariozechner/pi-agent-core) 的 `runAgentLoop` 提供（工具调用分发、参数 schema 校验、重试、超时、SSE 解析、各家 provider 适配）。本仓只保留**检索层**与**提示词**。

```
用户提问
  │
  ▼
┌─── runAgentLoop (pi-agent-core) ─────────────────────┐
│                                                       │
│  LLM 流式调用 (with tools) ──→ 返回 toolCall?         │
│       │                          │                    │
│       │ 否（纯文本）              │ 是                 │
│       ▼                          ▼                    │
│  ┌─────────┐        执行 AgentTool.execute            │
│  │最终答案  │        → 结果注入 toolResult 消息        │
│  └─────────┘                      │                   │
│                                   ▼                   │
│                    shouldStopAfterTurn 预算闸门       │
│                    (llmCalls >= 7 → 收尾退出)         │
│                                                       │
└───────────────────────────────────────────────────────┘
```

## Loop 机制

编排能力全部来自 pi-agent-core，本仓只保留预算闸门、Ledger 与提示词：

| 职责 | 归属 | 说明 |
|------|------|------|
| 预算闸门 | 本仓 | `shouldStopAfterTurn` 计数，`MAX_LLM_CALLS = 7`（6 轮检索 + 1 轮收尾）。这是唯一的成本上限 |
| 重试 | pi-ai provider | OpenAI SDK 的 `maxRetries: 2`，只对 429/5xx/网络错误重试并遵循 `Retry-After`（旧实现按 `error.message` 文本匹配状态码，不可靠） |
| 超时 | pi-ai provider | `timeoutMs: 60000` 传给 SDK client；总结型问题携带 200 条消息生成回答，30s 会误杀 |
| 工具分发 | pi-agent-core | 含 JSON Schema 参数校验：参数不合法时把校验错误作为 toolResult 回灌给模型，模型可自行纠正 |
| provider 适配 | pi-ai | 流式解析、tool_call 增量拼接、消息格式转换 |
| Ledger 结构化状态 | 本仓 | 在工具调用之间累积 facts / searchHistory / citations，独立于对话上下文（参考 LedgerAgent 论文，2026-06） |

### 网关兼容性

`toPiModel()` 显式关闭了几个 OpenAI 专有字段，因为 pi-ai 的自动探测只对已知域名生效，而本项目面对的是用户自建代理：

```js
compat: {
  supportsStore: false,          // store: false 会被自建网关拒
  supportsDeveloperRole: false,  // 用 system 而非 developer 角色
  supportsReasoningEffort: false,
  supportsStrictMode: false,     // 不下发 tool.function.strict
  maxTokensField: 'max_tokens',  // 而非 max_completion_tokens
}
```

要求：代理兼容 `/v1/chat/completions` 且**支持 SSE 流式**（provider 固定 `stream: true`）。

## 工具定义

| 工具 | 用途 | 参数 |
|------|------|------|
| `count_messages` | 日期直方图探测（先宽后窄） | keywords[]?, person?, dateFrom?, dateTo? |
| `search_messages` | 块级 BM25 检索 + 人名/日期过滤 | keywords[], person?, dateFrom?, dateTo? |
| `get_context` | 按消息 id 还原前后完整对话 | messageId, span? |
| `get_recent_messages` | 时间段浏览（无关键词过滤） | dateFrom, dateTo, limit? |

`TOOL_SPECS` 用扁平 schema（`name` / `label` / `description` / `parameters`）声明，由 `buildAgentTools()` 包成 pi 的 `AgentTool`；OpenAI 的 `{ type:'function', function:{...} }` 信封由 provider 层生成，本仓不再手拼。

## 搜索实现

`search_messages` 是**块级 BM25 + 时间衰减 + LLM 精排**的三段流水线，检索单元是**话题块**而非单条消息。主路径 `searchByChunks()`，兜底路径 `searchFlat()`。

```
消息来源: output/{group}/*.json → loadMessages() → allMessages[]
  │
  ├─ 日期/人名过滤（person 匹配不到时保留全量 + personNote 告知，靠关键词兜底）
  ▼
切块 lib/chat-chunks.js splitIntoChunks()
  ① 相邻消息间隔 > 30 分钟 → 话题切换，断开
  ② 超过 50 条的长块，在内部最大间隔处（中间 60% 区域内）递归对半切
  ▼
块文本 = [LLM 标注] + 块内消息（user + content + share.title）
  │   标注来自 qa-index/chunks_<date>.json（离线回填，见下）；缺失则无标注
  ▼
BM25 打分 lib/search-bm25.js（bigram 分词，top 20）
  ▼
时间衰减 applyTimeDecay()：score × 0.5^(Δt / 2天)
  │   问"最近"时新消息优先，避免几天前的高分讨论挤掉今天的对话
  ▼
LLM 精排 rerankFilter()：只做相关性过滤，顺序仍按衰减分
  │   失败静默降级为 BM25 原序（不影响可用性）
  ▼
top 8 块 → 每块内部再做一次小 BM25 定位命中点（hitIds 用它，精确）
           块本身即上下文；> 30 条的块取首个命中 ±8 条防吃 token
```

### 为什么是块级

单条群聊消息只有十几个字，BM25 对超短文档打分不稳；群聊的语义单位是话题串。块级检索同时解决了"命中一句但看不懂上下文"的问题——块本身就是上下文，不需要固定 ±N 条。

`chunks.length < 2`（语料太小）或块级零命中时返回 `null`，降级到 `searchFlat()` 走单条消息 BM25（top 40 → 衰减 → 精排 → top 15 → `expandContext` 动态窗口 + 合并重叠区间）。

### bigram 分词

中文无空格，纯 `includes()` 子串匹配会让"投资"匹配不到"投了"。`lib/search-bm25.js` 把 CJK 连续段切成二字滑窗（"半导体" → `半导`/`导体`），拉丁/数字段整体小写作为一个词。部分重叠自然获得部分分数（"投资" vs "投资人" 共享 bigram "投资"），无需词典。

### 离线标注层（contextual BM25）

`scripts/build-qa-index.mjs` 为每个块生成 50–100 字标注（话题是什么 / 主要参与者 / 有无结论），前置到块文本参与 BM25 与精排：

```bash
node scripts/build-qa-index.mjs --group <群名> --all
```

- 幂等可中断：每完成一个 date 立即落盘，重跑跳过已完成的
- 标注复用：`chunkKey`（msgIds 指纹）不变则沿用旧标注——增量归档只追加当天尾部，前面的块 key 不变
- 新鲜度：`sourceMtime` 与日文件比对，不一致视为过期
- **QA 对索引无硬依赖**：缺失/过期/损坏一律降级为即时切块（无标注）

### 已知限制

- **跨词汇鸿沟靠 LLM 精排，不是 embedding**。网关通常无 embedding 模型可用，所以用一次轻量 LLM 调用代替向量相似度。代价是每次检索多一次 LLM 往返（20s 超时，失败降级）。
- **每次查询重建 BM25 索引**。消息量在数千级，毫秒级构建，不持久化。语料显著增大后需要改为持久化倒排。
- **用户别名不互通**：靠 LLM 自行推测 "tk" → "tombkeeper"，无别名映射表。
- **噪音过滤只在查看器侧**（`lib/text-utils.js` 的 `isNoise`，红包/签到机器人），检索侧未接入。

## 两种模式

| | Agent 模式 | Legacy 模式 |
|---|---|---|
| 调用方式 | `mode=agent`（默认） | `mode=legacy` |
| LLM 调用数 | 3-4 次（迭代搜索） | 2 次（提取+总结） |
| 搜索策略 | LLM 自主决策，可多轮换词 | 固定：提取关键词→单次搜索 |
| 延迟 | ~20s | ~10s |
| 质量 | 高（正确日期推理、多关键词扩展） | 中（偶尔关键词偏差、日期错误） |

## Benchmark 结果

> ⚠️ **下表为 2026-07 的历史记录，已过期且不可复现。** 它早于块级 BM25 检索重写与
> pi-agent-core 迁移；原始脚本在 `eval/`（agent 工作目录，随 ee2a63d 一起 untrack
> 移除），测试组是私有归档。保留它是为了记录「为什么 Agent 模式是默认」的判断依据，
> 不代表当前性能。要拿当前数字，用下面的 `scripts/benchmark-qa.js` 在你自己的归档上跑。

测试组: 茧房建筑师协会 (56天数据)，5 个问题

| 问题 | Agent(ms) | Legacy(ms) | Agent步骤 | 质量差异 |
|------|-----------|------------|-----------|----------|
| 最近tk说了什么 | 29001 | 12179 | 7 | Agent搜"tk"+"tombkeeper"; Legacy错用"发言,言论" |
| 昨天有讨论投资吗 | 10752 | 4843 | 6 | Agent搜6个金融词确认无结果; Legacy正确 |
| 群里谁在讨论AI | 19139 | 12063 | 5 | Agent找到6月最新; Legacy返回4月旧数据 |
| 上周分享过什么链接 | 18698 | 7304 | 5 | Agent日期正确(6/15-21); **Legacy搜错周(6/8-14)** |
| 最近大家在聊什么话题 | 24790 | 14113 | 5 | Agent浏览多段时间; Legacy只看1天 |

**汇总:** Agent 平均 20.5s / Legacy 平均 10.1s / 均 100% 成功率

延迟一项现在应当更低：新循环不再付固定重试等待，并遵循 `Retry-After`（实测两次 429
的自愈 3011ms → 1407ms），所以上表偏保守而非偏乐观。

### 自己复现

```bash
node scripts/viewer-server.js &                             # 先起查看器
node scripts/benchmark-qa.js --group <群名>                  # 内置 5 个通用问题
node scripts/benchmark-qa.js --group <群名> --repeat 3       # 多次取中位数
node scripts/benchmark-qa.js --group <群名> --questions my.json --json
```

`--questions` 接受字符串数组或 `{ questions: [{ question }] }`。脚本**只测延迟与是否
成功，不判答案对错**——答案质量要人工核对 golden facts，那属于私有数据，不入库。这也是
上表「质量差异」一列无法自动复现的原因。

## 配置

页面右上角 ⚙️ AI 设置面板，或手动创建 `ai-config.json`（已 gitignore）：

```json
{
  "baseUrl": "http://your-proxy/v1",
  "apiKey": "sk-xxx",
  "model": "claude-sonnet-4-6",
  "vision": false
}
```

要求：
- 代理需支持 OpenAI Chat Completions 格式 (`/v1/chat/completions`)
- **代理需支持 SSE 流式响应**：pi-ai 的 provider 固定发 `stream: true`，非流式代理会返回空 content
- 模型需支持 Function Calling（tool_calls）

## 文件结构

```
scripts/qa-agent.mjs        # 检索层 + 提示词 + tools/model 适配（loop 来自 pi-agent-core）
scripts/viewer-server.js    # /api/qa 端点，分发 agent/legacy 模式
scripts/build-qa-index.mjs  # 离线标注回填（qa-index/）
scripts/benchmark-qa.js     # 延迟基准（agent vs legacy），不依赖私有数据
ai-config.json              # AI 配置（gitignored）
```

依赖：`@mariozechner/pi-agent-core`（+ 传递依赖 `@mariozechner/pi-ai`）。`@opentelemetry/api` 是显式直接依赖，因为传递依赖 `@mistralai/mistralai` 会 import 它，缺失时 `bun build --compile`（sidecar 打包）解析失败。
