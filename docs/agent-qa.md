# Agent Q&A 技术方案

## 架构概述

Q&A 功能采用 **Agentic Search** 模式：LLM 在迭代循环中自主决定搜索策略、执行工具、评估结果充分性，直到可以生成最终回答。

```
用户提问
  │
  ▼
┌─── Conversation Loop (IterationBudget ≤ 6) ──────────┐
│                                                       │
│  LLM Call (with tools) ──→ 返回 tool_calls?           │
│       │                          │                    │
│       │ 否（纯文本）              │ 是                 │
│       ▼                          ▼                    │
│  ┌─────────┐          执行 tool → 结果注入 messages   │
│  │最终答案  │                      │                   │
│  └─────────┘                      ▼                   │
│                           budget.consume()            │
│                           继续循环 ───────────────────│
│                                                       │
└───────────────────────────────────────────────────────┘
```

## Loop 机制

参考两个开源 Agent 框架的核心模式：

### Hermes Agent (NousResearch, 199K⭐)

- **IterationBudget**: 可消费计数器，`consume()` / `remaining` / `refund()`
- **Grace Call**: 预算耗尽时允许模型再做一次回答，避免搜了多轮但没机会总结
- **While 循环**: `while (budget.shouldContinue)` 而非固定 for-loop

### Pi-Multi-Agent (TypeScript, 生产级编排框架)

- **AgentState**: idle → running → completed | failed 状态机
- **withRetry + backoff**: 处理 429/500/503 等瞬态错误
- **withTimeout**: Promise.race 防止单次调用挂死
- **Metrics**: 记录步数、工具调用数、执行时间

### LedgerAgent (论文, 2026-06)

- **Ledger 结构化状态**: 在工具调用之间累积 facts / searchHistory / confidence
- 非 prompt-only 的状态跟踪，独立于对话上下文

## 工具定义

| 工具 | 用途 | 参数 |
|------|------|------|
| `search_messages` | 关键词搜索 + 人名/日期过滤 | keywords[], person?, dateFrom?, dateTo? |
| `get_recent_messages` | 时间段浏览（无关键词过滤） | dateFrom, dateTo, limit? |

工具使用 OpenAI Function Calling 标准格式，schema 显式包含 `"type": "object"`（Bedrock 要求）。

## 搜索实现

**当前方案：全量遍历原始 JSON**

```
消息来源: output/{group}/*.json → loadMessages() → allMessages[]
搜索方式: 遍历 allMessages，字符串 includes() 匹配
评分: 关键词命中 +1 分，人名命中 +3 分
返回: top 15 命中，每条 ±3 条上下文，最多 8 段
```

### 已知限制

- O(n) 全量扫描，无索引
- 纯字符串匹配，不支持语义搜索（"人工智能" ≠ "AI"）
- 未过滤噪音消息（红包提示、系统消息）
- 无分词，中文长句匹配依赖 LLM 拆词能力
- 用户别名不互通（靠 LLM 自行推测 "tk" → "tombkeeper"）

### 改进方向

1. **预处理层**: 过滤噪音、标准化时间格式、建用户别名映射表
2. **轻量索引**: MiniSearch / Lunr 内存倒排索引，支持中文分词
3. **语义检索**: Embedding 向量化 + 相似度搜索（需额外模型调用）

## 两种模式

| | Agent 模式 | Legacy 模式 |
|---|---|---|
| 调用方式 | `mode=agent`（默认） | `mode=legacy` |
| LLM 调用数 | 3-4 次（迭代搜索） | 2 次（提取+总结） |
| 搜索策略 | LLM 自主决策，可多轮换词 | 固定：提取关键词→单次搜索 |
| 延迟 | ~20s | ~10s |
| 质量 | 高（正确日期推理、多关键词扩展） | 中（偶尔关键词偏差、日期错误） |

## Benchmark 结果

测试组: 茧房建筑师协会 (56天数据)，5 个问题

| 问题 | Agent(ms) | Legacy(ms) | Agent步骤 | 质量差异 |
|------|-----------|------------|-----------|----------|
| 最近tk说了什么 | 29001 | 12179 | 7 | Agent搜"tk"+"tombkeeper"; Legacy错用"发言,言论" |
| 昨天有讨论投资吗 | 10752 | 4843 | 6 | Agent搜6个金融词确认无结果; Legacy正确 |
| 群里谁在讨论AI | 19139 | 12063 | 5 | Agent找到6月最新; Legacy返回4月旧数据 |
| 上周分享过什么链接 | 18698 | 7304 | 5 | Agent日期正确(6/15-21); **Legacy搜错周(6/8-14)** |
| 最近大家在聊什么话题 | 24790 | 14113 | 5 | Agent浏览多段时间; Legacy只看1天 |

**汇总:** Agent 平均 20.5s / Legacy 平均 10.1s / 均 100% 成功率

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
- 模型需支持 Function Calling（tool_calls）
- Tool schema 需包含 `"type": "object"`（Bedrock 要求）

## 文件结构

```
qa-agent.mjs          # Agent 实现（loop + tools + ledger）
viewer-server.js      # /api/qa 端点，分发 agent/legacy 模式
benchmark-qa.mjs      # 对比测试脚本
ai-config.json        # AI 配置（gitignored）
```

## 运行 Benchmark

```bash
npm run view          # 启动 server
node benchmark-qa.mjs # 运行对比测试
```
