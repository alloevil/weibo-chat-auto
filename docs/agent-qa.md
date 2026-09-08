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

`scripts/build-qa-index.mjs` 为每个块生成两样东西，都前置到块文本参与 BM25：

1. **摘要**：50–100 字（话题是什么 / 主要参与者 / 有无结论）
2. **别名**：2–4 条「用完全不同词汇」的替代说法

```bash
node scripts/build-qa-index.mjs --group <群名> --all
```

索引文件格式（`output/<群>/qa-index/chunks_<date>.json`）：

```json
{
  "seq": 0, "key": "a1b2c3", "msgIds": ["900", "901"],
  "annotation": "话题:股票操作。参与:tombkeeper。结论:还没跌到位。",
  "aliases": ["减持科技股", "看空半导体", "调整投资仓位"]
}
```

**别名为什么有用**：BM25 只认字面。原文写「把手里的芯片股清了一半」，用户问「谁在减持」或「有人聊投资吗」时词面零交集 → 零命中。别名把同义改写在**索引期**写进检索文本，BM25 自己就能匹配，不必每次查询再花一轮 LLM 精排（省一次往返 + 20s 超时风险）。

设计依据是 Chronos（[arXiv 2603.16862](https://arxiv.org/abs/2603.16862)）：它在抽取事件时额外生成 2–4 条完全换词的改写（`"bought Fitbit"` → `"picked up a fitness tracker"`），专门用于提升字面检索召回。

关键约束（写在 prompt 里）：**不要复用原话里的关键名词**。只换语序不换词的改写对 bigram BM25 毫无增益 —— 切出来的 bigram 完全相同。

**别名只进 BM25 打分，不进给模型看的 snippet**。否则模型会把改写当成群里真实说过的话，进而编造引文。片段里只有 `【话题标注】` + 真实消息原文。

- 幂等可中断：每完成一个 date 立即落盘，重跑跳过已完成的
- 标注复用：`chunkKey`（msgIds 指纹）不变则沿用旧标注与别名——增量归档只追加当天尾部，前面的块 key 不变
- 新鲜度：`sourceMtime` 与日文件比对，不一致视为过期
- 别名缺失不算失败：模型漏写别名时只保留摘要照常落盘（别名是增量优化，不该让整批标注失败）
- 旧索引（本功能之前生成、无 `aliases` 字段）按空数组处理，行为不变
- **QA 对索引无硬依赖**：缺失/过期/损坏一律降级为即时切块（无标注无别名）

### 预处理层

检索前两道过滤，`count_messages` / `search_messages` / `get_recent_messages` 共用：

**① 噪音剔除**（`dropNoise`，规则复用 `lib/text-utils.js` 的 `isNoise`）

红包提示、抢红包回执、签到机器人（实测占「提到我」命中的 93%）不进检索。理由：噪音块参与 BM25 会稀释真话题的相对分数，且总结型问题会把「大家在聊什么」答成红包和签到。计数也过滤——否则「某人最近活跃吗」被机器人刷屏带偏。

两个刻意的例外：
- **全量都是噪音时退回原语料**：宁可让模型看到噪音，也不要给它空语料让它以为这段时间没人说话。
- **`get_context` 不过滤**：它按 id 定位，走全量语料。过滤会让 `search_messages` 返回的 hitIds 查不到，也会在上下文窗口里留空洞。

**② 发言人别名解析**（`lib/speaker-aliases.js`）

群里没人用全名称呼彼此。问「tk 最近说了什么」时，`person` 过滤匹配不到任何 `user` → 退回全量搜索，而「tk」在正文里也几乎不出现 → 零命中。历史 benchmark 第一行「Agent 搜 "tk"+"tombkeeper"」就是模型在替这个缺口打补丁：多花一轮 LLM 往返去猜别名。

映射表放在 `output/<群>/aliases.json`（与 `qa-index/` 同级，跟群走）：

```json
{ "tombkeeper": ["tk", "TK"], "张三丰": ["三丰", "老张"] }
```

键是归档里的真实 `user` 名，值是别名列表。命中后：
- `person` 过滤精确筛到真名，并回传 `personNote: 发言人 "tk" 已解析为:tombkeeper`（让模型后续轮次直接用真名）
- 别名同时扩进 BM25 查询——正文里可能写「tombkeeper」也可能写「@tk」，两边都该有分

三级匹配逐级放宽，前一级有结果就不再放宽（避免「张三」把「张三丰」也带出来）：别名表精确命中 → `user` 名精确相等 → 子串包含（与原有行为一致，保持兼容）。

文件缺失/损坏/写成数组 → 空表降级，检索行为与加此功能前完全一致。表里写了尚未发言的人则不返回他，不硬造结果。

### 已知限制

- **跨词汇鸿沟有两道防线，都不是 embedding**：索引期别名改写（离线，无在线成本）+ LLM 精排（每次检索一次往返，20s 超时，失败降级）。别名覆盖不到的提问才依赖精排。网关通常无 embedding 模型可用，所以没走向量路线；[arXiv 2605.15184](https://arxiv.org/abs/2605.15184) 在 LongMemEval 上的结果也显示，对话历史检索里 inline 字面检索的准确率反而全面高于向量检索。
- **每次查询重建 BM25 索引**。消息量在数千级，毫秒级构建，不持久化。语料显著增大后需要改为持久化倒排。
- **别名表需手写**，没有从 `@提及` 或历史对话自动挖掘。
- **`isNoise` 是规则匹配**（正则 + 关键词），新型机器人话术要手工补规则。

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
lib/speaker-aliases.js      # 发言人别名解析（tk → tombkeeper）
lib/search-bm25.js          # bigram 分词 + BM25
lib/chat-chunks.js          # 话题块切分
lib/chunk-index.js          # 离线标注索引的加载与降级
ai-config.json              # AI 配置（gitignored）
output/<群>/aliases.json    # 发言人别名表（手写，可选）
output/<群>/qa-index/       # 离线标注（可选，缺失自动降级）
```

依赖：`@mariozechner/pi-agent-core`（+ 传递依赖 `@mariozechner/pi-ai`）。`@opentelemetry/api` 是显式直接依赖，因为传递依赖 `@mistralai/mistralai` 会 import 它，缺失时 `bun build --compile`（sidecar 打包）解析失败。
