import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { createRequire } from 'module';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
// BM25 检索层（CJS 模块，bigram 分词，见 lib/search-bm25.js）
const { search: bm25Search } = require('./lib/search-bm25.js');

function loadAiConfig() {
  const cfgPath = path.join(__dirname, 'ai-config.json');
  if (!fs.existsSync(cfgPath)) return null;
  return JSON.parse(fs.readFileSync(cfgPath, 'utf-8'));
}

function formatMessage(m) {
  const t = m.time ? m.time.split(' ')[1]?.slice(0, 5) : '';
  const date = m.time ? m.time.split(' ')[0].replace(/\//g, '-') : '';
  let text = m.content || '';
  if (m.share) text += ` [分享: ${m.share.title || m.share.url || ''}]`;
  if (m.pics?.length) text += ` [图片x${m.pics.length}]`;
  return `[${date} ${t}] ${m.user}: ${text}`;
}

// ─── IterationBudget (adapted from Hermes Agent) ───────────────────────
// Controls how many LLM calls the agent can make per question.
// Supports consume/refund/grace-call semantics.
class IterationBudget {
  constructor(maxTotal) {
    this.maxTotal = maxTotal;
    this._used = 0;
    this._graceCall = false;
  }

  consume() {
    if (this._used >= this.maxTotal) return false;
    this._used++;
    return true;
  }

  refund() {
    if (this._used > 0) this._used--;
  }

  enableGrace() {
    this._graceCall = true;
  }

  get used() { return this._used; }
  get remaining() { return Math.max(0, this.maxTotal - this._used); }
  get shouldContinue() { return this.remaining > 0 || this._graceCall; }

  consumeGrace() {
    if (this._graceCall) {
      this._graceCall = false;
      return true;
    }
    return false;
  }
}

// ─── AgentState (adapted from Pi-Multi-Agent) ──────────────────────────
// Tracks lifecycle state + metrics for observability.
class AgentState {
  constructor() {
    this.status = 'idle'; // idle → running → completed | failed
    this.steps = [];
    this.startTime = null;
    this.endTime = null;
  }

  transition(newStatus) {
    this.status = newStatus;
    if (newStatus === 'running') this.startTime = Date.now();
    if (newStatus === 'completed' || newStatus === 'failed') this.endTime = Date.now();
  }

  recordStep(step) {
    this.steps.push({ ...step, timestamp: Date.now() });
  }

  get executionTime() {
    if (!this.startTime) return 0;
    return (this.endTime || Date.now()) - this.startTime;
  }

  get metrics() {
    return {
      status: this.status,
      totalSteps: this.steps.length,
      toolCalls: this.steps.filter(s => s.type === 'tool_call').length,
      llmCalls: this.steps.filter(s => s.type === 'llm_call').length,
      executionTime: this.executionTime,
    };
  }
}

// ─── Retry with backoff (adapted from Pi-Multi-Agent) ──────────────────
async function withRetry(fn, { maxRetries = 2, initialDelay = 1000, backoffMultiplier = 2 } = {}) {
  let lastError;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (e) {
      lastError = e;
      const isRetryable = e.message?.includes('429') || e.message?.includes('500') || e.message?.includes('503');
      if (!isRetryable || attempt >= maxRetries) throw e;
      const delay = initialDelay * Math.pow(backoffMultiplier, attempt);
      await new Promise(r => setTimeout(r, delay));
    }
  }
  throw lastError;
}

// ─── Timeout (adapted from Pi-Multi-Agent) ─────────────────────────────
function withTimeout(promise, ms) {
  return Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error(`Agent timeout after ${ms}ms`)), ms)),
  ]);
}

// ─── LedgerAgent-style structured state ────────────────────────────────
function createLedger() {
  return {
    facts: [],
    searchHistory: [],
    citations: [],       // 真实消息引用（id/date/user/preview），供前端跳转
    totalMatches: 0,
    dateRangeUsed: null,
    confidence: 'low',
  };
}

// ─── Tool definitions (OpenAI format with Bedrock-required type field) ─
const TOOLS = [
  {
    type: 'function',
    function: {
      name: 'search_messages',
      description: '在群聊记录中按关键词检索（BM25 相关性排序，支持中文部分匹配）。适合找"某人说了什么/某话题被谁提过"这类事实检索。返回相关片段（含对话上下文）。可多次调用换关键词。',
      parameters: {
        type: 'object',
        properties: {
          keywords: { type: 'array', items: { type: 'string' }, description: '搜索关键词列表。建议同时给出同义词/相关词（如问"大模型"时加上 LLM、GPT、AI）以提高召回' },
          person: { type: 'string', description: '筛选特定发言人（模糊匹配）' },
          dateFrom: { type: 'string', description: '起始日期 YYYY-MM-DD' },
          dateTo: { type: 'string', description: '结束日期 YYYY-MM-DD' },
        },
        required: ['keywords'],
        additionalProperties: false,
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'get_recent_messages',
      description: '直接读取某时间段的聊天记录（超过 limit 时均匀采样，保证时间覆盖）。适合"大家在聊什么/总结一下/有什么话题"这类总结归纳型问题——这类问题不要用关键词搜索。',
      parameters: {
        type: 'object',
        properties: {
          dateFrom: { type: 'string', description: '起始日期 YYYY-MM-DD' },
          dateTo: { type: 'string', description: '结束日期 YYYY-MM-DD' },
          limit: { type: 'number', description: '最多返回条数，默认120，上限200' },
        },
        required: ['dateFrom', 'dateTo'],
        additionalProperties: false,
      },
    },
  },
];

// ─── LLM reranker ──────────────────────────────────────────────────────
// BM25 是词面匹配，跨不过词汇鸿沟（"卖掉半导体"与"投资"无共享词）。
// 网关无 embedding 模型可用，改用一次轻量 LLM 调用对候选做语义精排：
// 给出问题 + 编号候选列表，让模型返回真正相关的编号（按相关度排序）。
// 失败时静默降级为原始 BM25 排序，不影响可用性。
async function rerankByLLM(config, question, candidates) {
  const list = candidates.map((c, i) => `${i}. ${c.text.slice(0, 120)}`).join('\n');
  const prompt = `用户问题：${question}

以下是候选聊天消息（编号. 内容）：
${list}

请判断哪些消息与用户问题真正相关（语义相关即可，不要求字面匹配；如消息谈论的具体事物属于问题所问的范畴，也算相关）。
只输出 JSON 数组（相关消息的编号，按相关度从高到低），不要其他文字。例如：[3,0,12]`;

  const resp = await fetch(`${config.baseUrl}/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${config.apiKey}` },
    body: JSON.stringify({
      model: config.model,
      messages: [{ role: 'user', content: prompt }],
      stream: false,
    }),
  });
  if (!resp.ok) throw new Error(`rerank API ${resp.status}`);
  const data = await resp.json();
  const text = data.choices?.[0]?.message?.content || '';
  const m = text.match(/\[[\d,\s]*\]/);
  if (!m) throw new Error('rerank: no JSON array in response');
  const order = JSON.parse(m[0]).filter(i => Number.isInteger(i) && i >= 0 && i < candidates.length);
  if (!order.length) throw new Error('rerank: empty result');
  return order;
}

// ─── Tool execution ────────────────────────────────────────────────────
// 动态上下文窗口：从命中点向前后扩展，直到出现时间断层（>30 分钟，通常意味
// 着话题切换）或达到上限。替代固定 ±3 条——群聊话题绵延时不再掐头去尾。
function expandContext(msgs, hitIdx, { gapMs = 30 * 60 * 1000, maxSpan = 12 } = {}) {
  let start = hitIdx, end = hitIdx;
  while (start > 0 && (hitIdx - start) < maxSpan / 2) {
    const cur = msgs[start], prev = msgs[start - 1];
    if (cur.timestamp && prev.timestamp && cur.timestamp - prev.timestamp > gapMs) break;
    start--;
  }
  while (end < msgs.length - 1 && (end - hitIdx) < maxSpan / 2) {
    const cur = msgs[end], next = msgs[end + 1];
    if (cur.timestamp && next.timestamp && next.timestamp - cur.timestamp > gapMs) break;
    end++;
  }
  return [start, end + 1]; // [start, end)
}

async function executeTool(name, args, allMessages, ledger, config, question) {
  if (name === 'search_messages') {
    const { keywords = [], person, dateFrom, dateTo } = args;
    let msgs = allMessages;

    if (dateFrom || dateTo) {
      msgs = msgs.filter(m => {
        const d = (m.time || '').split(' ')[0].replace(/\//g, '-');
        if (!d) return false;
        if (dateFrom && d < dateFrom) return false;
        if (dateTo && d > dateTo) return false;
        return true;
      });
    }
    if (person) {
      const p = person.toLowerCase();
      const byPerson = msgs.filter(m => (m.user || '').toLowerCase().includes(p));
      // 有匹配者按人筛选；没有则保留全量（人名可能记错，让关键词兜底）
      if (byPerson.length > 0) msgs = byPerson;
    }

    // BM25 检索（bigram 分词，词频/文档长度归一），替代 includes 命中计数
    const docs = msgs.map(m => (m.user || '') + ' ' + (m.content || '') + ' ' + (m.share?.title || ''));
    const query = keywords.join(' ');
    let hits = bm25Search(docs, query, { limit: 40 });

    // 时间衰减加权：问"最近"时用户更关心新消息，纯相关性会让几天前的
    // 高分讨论把今天的对话挤出 top-N。半衰期 2 天，只在范围内相对衰减。
    const latestTs = msgs.reduce((mx, m) => Math.max(mx, m.timestamp || 0), 0);
    if (latestTs) {
      const HALF_LIFE = 2 * 86400000;
      hits = hits.map(h => {
        const ts = msgs[h.idx].timestamp || 0;
        const age = latestTs - ts;
        return { ...h, score: h.score * Math.pow(0.5, age / HALF_LIFE) };
      }).sort((a, b) => b.score - a.score);
    }
    hits = hits.slice(0, 40);

    // LLM 语义精排：跨过词汇鸿沟（BM25 只认字面）。
    // 注意：reranker 只做「相关性过滤」，最终顺序仍按时间衰减分——否则
    // 语义排序会覆盖新近度偏好，几天前的高相关长讨论再次淹没今天的消息。
    let reranked = false;
    if (config && question && hits.length > 3) {
      try {
        const candidates = hits.map(h => ({ idx: h.idx, text: docs[h.idx] }));
        const order = await withTimeout(rerankByLLM(config, question, candidates), 20000);
        const keep = new Set(order);
        const filtered = hits.filter((_, i) => keep.has(i));
        if (filtered.length) {
          hits = filtered; // 已是时间衰减分降序，过滤不改变顺序
          reranked = true;
        }
      } catch (e) {
        console.error('[qa] rerank 降级为 BM25:', e.message);
      }
    }
    hits = hits.slice(0, 15);

    // 命中点 → 动态上下文片段（合并重叠区间）
    const ranges = hits
      .map(h => expandContext(msgs, h.idx))
      .sort((a, b) => a[0] - b[0]);
    const merged = [];
    for (const r of ranges) {
      const last = merged[merged.length - 1];
      if (last && r[0] <= last[1]) last[1] = Math.max(last[1], r[1]);
      else merged.push([...r]);
    }
    const chunks = merged.slice(0, 8).map(([s, e]) => msgs.slice(s, e).map(formatMessage).join('\n'));

    // 真实引用：top 命中的消息 id/日期/预览，供最终 sources 使用
    const citations = hits.slice(0, 8).map(h => {
      const m = msgs[h.idx];
      return {
        id: m.id,
        date: (m.time || '').split(' ')[0].replace(/\//g, '-'),
        user: m.user,
        preview: (m.content || m.share?.title || '').slice(0, 60),
      };
    });
    ledger.citations.push(...citations);

    ledger.searchHistory.push({ keywords, person, dateFrom, dateTo, matchCount: hits.length });
    ledger.totalMatches += hits.length;
    if (dateFrom || dateTo) ledger.dateRangeUsed = { from: dateFrom, to: dateTo };
    if (hits.length > 5) ledger.confidence = hits.length > 12 ? 'high' : 'medium';

    return {
      matchCount: hits.length,
      totalInRange: msgs.length,
      reranked,
      dateRange: (dateFrom || dateTo) ? `${dateFrom || '?'} ~ ${dateTo || '?'}` : '全部',
      snippets: chunks,
    };
  }

  if (name === 'get_recent_messages') {
    const { dateFrom, dateTo, limit } = args;
    const maxCount = Math.min(limit || 120, 200);
    const msgs = allMessages.filter(m => {
      const d = (m.time || '').split(' ')[0].replace(/\//g, '-');
      if (!d) return false;
      if (dateFrom && d < dateFrom) return false;
      if (dateTo && d > dateTo) return false;
      return true;
    });
    // 超出上限时均匀采样而非只取尾部，避免总结型问题的时间偏差
    let sample;
    if (msgs.length <= maxCount) {
      sample = msgs;
    } else {
      sample = [];
      const step = msgs.length / maxCount;
      for (let i = 0; i < maxCount; i++) sample.push(msgs[Math.floor(i * step)]);
    }
    // 浏览到的消息也进引用池（取均匀几条代表）
    for (let i = 0; i < sample.length; i += Math.ceil(sample.length / 5) || 1) {
      const m = sample[i];
      ledger.citations.push({
        id: m.id,
        date: (m.time || '').split(' ')[0].replace(/\//g, '-'),
        user: m.user,
        preview: (m.content || m.share?.title || '').slice(0, 60),
      });
    }
    ledger.searchHistory.push({ browse: true, dateFrom, dateTo, total: msgs.length });
    if (dateFrom || dateTo) ledger.dateRangeUsed = { from: dateFrom, to: dateTo };
    return { total: msgs.length, returned: sample.length, sampled: msgs.length > maxCount, messages: sample.map(formatMessage) };
  }

  return { error: `Unknown tool: ${name}` };
}

// ─── LLM call ──────────────────────────────────────────────────────────
async function callLLM(config, messages) {
  const resp = await fetch(`${config.baseUrl}/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${config.apiKey}`,
    },
    body: JSON.stringify({
      model: config.model,
      messages,
      tools: TOOLS,
      stream: false,
    }),
  });

  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(`LLM API ${resp.status}: ${text.slice(0, 200)}`);
  }

  const data = await resp.json();
  return data.choices?.[0]?.message;
}

// ─── Agent conversation loop ───────────────────────────────────────────
// Architecture references:
//   - Hermes Agent: IterationBudget + grace call + while-loop with interrupt
//   - Pi-Multi-Agent: state machine + timeout + retry with backoff
//   - LedgerAgent: structured state accumulation across iterations
async function conversationLoop(question, allMessages, config) {
  const budget = new IterationBudget(6);
  const state = new AgentState();
  const ledger = createLedger();
  const toolCallLog = [];

  state.transition('running');

  const today = new Date().toISOString().split('T')[0];
  const systemPrompt = `你是一个群聊记录问答助手。今天是 ${today}。

先判断问题类型，选对工具：

【事实检索型】"X 说了什么"、"谁提到过 Y"、"关于 Z 的讨论"
→ 用 search_messages。关键词同时给同义词/英文缩写（问"大模型"→ ["大模型","LLM","GPT","AI"]）。
→ 结果不足时换关键词或扩大日期范围再搜，不要轻易放弃。

【总结归纳型】"大家在聊什么"、"总结一下"、"最近有什么话题"、"聊天氛围如何"
→ 直接用 get_recent_messages 读取该时间段记录后归纳。不要用关键词搜索——总结不需要检索。

回答要求：
- 只基于聊天记录回答，不要编造
- 引用具体发言人和日期
- 找不到相关信息时明确告知
- 用中文回答

时间理解：
- "昨天" = ${new Date(Date.now() - 86400000).toISOString().split('T')[0]}
- "前天" = ${new Date(Date.now() - 172800000).toISOString().split('T')[0]}
- "最近" = 最近7天 (${new Date(Date.now() - 7 * 86400000).toISOString().split('T')[0]} ~ ${today})
- "上周" = 上一个完整周（周一到周日）`;

  const messages = [
    { role: 'system', content: systemPrompt },
    { role: 'user', content: question },
  ];

  // Main loop — modeled after Hermes's while(budget.shouldContinue || graceCall)
  while (budget.shouldContinue) {
    // Budget gate (Hermes pattern: consume or break)
    if (!budget.consume()) {
      if (!budget.consumeGrace()) {
        break;
      }
    }

    // LLM call with retry + timeout (Pi-Multi-Agent pattern)
    const assistantMsg = await withRetry(
      () => withTimeout(callLLM(config, messages), 30000),
      { maxRetries: 2, initialDelay: 1000 }
    );

    if (!assistantMsg) throw new Error('Empty LLM response');

    state.recordStep({ type: 'llm_call', iteration: budget.used });
    messages.push(assistantMsg);

    // Termination: no tool_calls → final answer
    if (!assistantMsg.tool_calls?.length) {
      state.transition('completed');
      return {
        answer: assistantMsg.content || '未能生成回答',
        toolCallLog,
        ledger,
        state: state.metrics,
      };
    }

    // Execute tool calls
    for (const tc of assistantMsg.tool_calls) {
      const args = JSON.parse(tc.function.arguments || '{}');
      const result = await executeTool(tc.function.name, args, allMessages, ledger, config, question);

      state.recordStep({ type: 'tool_call', tool: tc.function.name, args });
      toolCallLog.push({ tool: tc.function.name, ...args, matchCount: result.matchCount, returned: result.returned, total: result.total });

      messages.push({
        role: 'tool',
        tool_call_id: tc.id,
        content: JSON.stringify(result),
      });
    }

    // Grace call: if budget just exhausted, allow one more iteration for model to wrap up
    if (budget.remaining === 0 && !budget._graceCall) {
      budget.enableGrace();
    }
  }

  // Budget exhausted — return last assistant content
  state.transition('completed');
  const lastAssistant = messages.filter(m => m.role === 'assistant').pop();
  return {
    answer: lastAssistant?.content || '搜索已完成，但未能生成最终回答。',
    toolCallLog,
    ledger,
    state: state.metrics,
  };
}

// ─── Public API ────────────────────────────────────────────────────────
export async function askAgent(question, allMessages, aiConfigOverride) {
  const aiConfig = aiConfigOverride || loadAiConfig();
  if (!aiConfig) return { ok: false, error: 'AI 未配置' };

  try {
    const result = await conversationLoop(question, allMessages, aiConfig);

    const keywords = [...new Set(result.toolCallLog.flatMap(tc => tc.keywords || []))];
    // 真实消息引用（按 id 去重，最多 8 条）——前端可据 id 跳转到原消息
    const seenIds = new Set();
    const sources = [];
    for (const c of result.ledger.citations || []) {
      if (c.id == null || seenIds.has(c.id)) continue;
      seenIds.add(c.id);
      sources.push({ id: c.id, date: c.date, user: c.user, preview: c.preview });
      if (sources.length >= 8) break;
    }

    return {
      ok: true,
      answer: result.answer,
      sources,
      keywords,
      toolCalls: result.toolCallLog.map(tc => ({ tool: tc.tool, matchCount: tc.matchCount ?? tc.returned })),
      steps: result.state.totalSteps,
      ledger: result.ledger,
    };
  } catch (e) {
    return { ok: false, error: `Agent 错误: ${e.message}` };
  }
}
