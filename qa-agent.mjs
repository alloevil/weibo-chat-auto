import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { createRequire } from 'module';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
// BM25 检索层（CJS 模块，bigram 分词，见 lib/search-bm25.js）
const { search: bm25Search } = require('./lib/search-bm25.js');
// 话题块索引:离线标注(qa-index/)优先,缺失/过期时即时切块降级
const { loadChunkIndex, buildChunksForMessages } = require('./lib/chunk-index.js');

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
      name: 'count_messages',
      description: '统计消息在各日期的分布(直方图),不返回消息内容。这是"先宽后窄"的探测工具:在正式搜索前,先用它了解某话题/某人的发言集中在哪些日期,再把 search_messages 的日期范围锁定到热点日期。计算是本地词面匹配,成本极低,可放心多次调用。不带 keywords 时统计纯消息量(如"某人最近活跃吗")。不要用它获取消息内容——它只给数字。',
      parameters: {
        type: 'object',
        properties: {
          keywords: { type: 'array', items: { type: 'string' }, description: '统计包含任一关键词的消息(词面包含匹配,大小写不敏感)。省略则统计全部消息' },
          person: { type: 'string', description: '只统计该发言人的消息(模糊匹配)' },
          dateFrom: { type: 'string', description: '起始日期,格式 YYYY-MM-DD,如 2026-07-01' },
          dateTo: { type: 'string', description: '结束日期,格式 YYYY-MM-DD' },
        },
        additionalProperties: false,
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'search_messages',
      description: '按关键词检索聊天记录(BM25 相关性 + 时间新近度排序),返回相关片段(含对话上下文)和命中消息的 id 列表(hitIds)。适合"某人说了什么/某话题谁提过/关于 X 的讨论"这类事实检索。关键词务必同时给同义词和英文缩写(问"大模型"→ ["大模型","LLM","GPT","AI"]),单个关键词建议 2-4 字。零命中时返回的 hint 会告诉你怎么调整。不适合总结归纳型问题(用 get_recent_messages)。',
      parameters: {
        type: 'object',
        properties: {
          keywords: { type: 'array', items: { type: 'string' }, description: '搜索关键词列表,同时给出同义词/相关词/英文缩写以提高召回' },
          person: { type: 'string', description: '筛选特定发言人(模糊匹配)。注意:人名记不准时宁可不填,靠关键词兜底' },
          dateFrom: { type: 'string', description: '起始日期,格式 YYYY-MM-DD' },
          dateTo: { type: 'string', description: '结束日期,格式 YYYY-MM-DD' },
        },
        required: ['keywords'],
        additionalProperties: false,
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'get_context',
      description: '按消息 id 拉取该消息前后的完整对话(按 30 分钟时间断层自动截断到当前话题)。当 search_messages 的片段不足以回答问题、需要还原某条命中消息的来龙去脉时用。messageId 必须来自 search_messages 返回的 hitIds,不要凭空构造。',
      parameters: {
        type: 'object',
        properties: {
          messageId: { type: 'string', description: 'search_messages 返回的 hitIds 中的消息 id' },
          span: { type: 'number', description: '上下文最大条数,默认 24,上限 60' },
        },
        required: ['messageId'],
        additionalProperties: false,
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'get_recent_messages',
      description: '直接读取某时间段的聊天记录(超过 limit 时均匀采样,保证时间覆盖)。适合"大家在聊什么/总结一下/有什么话题/氛围如何"这类总结归纳型问题——这类问题不要用关键词搜索,直接读记录后归纳。不适合找具体某句话(用 search_messages)。',
      parameters: {
        type: 'object',
        properties: {
          dateFrom: { type: 'string', description: '起始日期,格式 YYYY-MM-DD' },
          dateTo: { type: 'string', description: '结束日期,格式 YYYY-MM-DD' },
          limit: { type: 'number', description: '最多返回条数,默认120,上限200' },
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

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/** 模型偶尔把 keywords 传成字符串/数字而非数组,归一成字符串数组。 */
function normalizeKeywords(keywords) {
  if (keywords == null) return [];
  const arr = Array.isArray(keywords) ? keywords : [keywords];
  return arr.map(k => String(k)).filter(Boolean);
}

function msgDate(m) {
  return (m.time || '').split(' ')[0].replace(/\//g, '-');
}

/** 日期参数格式校验。非法时返回可操作的错误对象(含格式示例),合法返回 null。 */
function validateDateArgs({ dateFrom, dateTo }) {
  for (const [k, v] of [['dateFrom', dateFrom], ['dateTo', dateTo]]) {
    if (v != null && !DATE_RE.test(v)) {
      return { error: `${k} 格式非法: "${v}"。必须是 YYYY-MM-DD,例如 "2026-07-03"` };
    }
  }
  return null;
}

function filterByDate(msgs, dateFrom, dateTo) {
  if (!dateFrom && !dateTo) return msgs;
  return msgs.filter(m => {
    const d = msgDate(m);
    if (!d) return false;
    if (dateFrom && d < dateFrom) return false;
    if (dateTo && d > dateTo) return false;
    return true;
  });
}

/** 全量数据的可用日期范围(引导 agent 修正越界的日期参数)。 */
function dateSpanOf(msgs) {
  if (!msgs.length) return null;
  return { first: msgDate(msgs[0]), last: msgDate(msgs[msgs.length - 1]) };
}

// ─── 检索流水线共用件 ──────────────────────────────────────────────────
const HALF_LIFE_MS = 2 * 86400000;

function msgText(m) {
  return (m.user || '') + ' ' + (m.content || '') + ' ' + (m.share?.title || '');
}

// 时间衰减加权:问"最近"时用户更关心新消息,纯相关性会让几天前的
// 高分讨论把今天的对话挤出 top-N。半衰期 2 天,只在范围内相对衰减。
function applyTimeDecay(hits, tsOf) {
  const latestTs = hits.reduce((mx, h) => Math.max(mx, tsOf(h.idx) || 0), 0);
  if (!latestTs) return hits;
  return hits
    .map(h => ({ ...h, score: h.score * Math.pow(0.5, (latestTs - (tsOf(h.idx) || 0)) / HALF_LIFE_MS) }))
    .sort((a, b) => b.score - a.score);
}

// LLM 语义精排:跨过词汇鸿沟(BM25 只认字面)。只做「相关性过滤」,
// 最终顺序仍按时间衰减分——否则语义排序会覆盖新近度偏好。
// 失败静默降级,返回原 hits。
async function rerankFilter(hits, textOf, config, question) {
  if (!config || !question || hits.length <= 3) return { hits, reranked: false };
  try {
    const candidates = hits.map(h => ({ idx: h.idx, text: textOf(h.idx) }));
    const order = await withTimeout(rerankByLLM(config, question, candidates), 20000);
    const keep = new Set(order);
    const filtered = hits.filter((_, i) => keep.has(i));
    if (filtered.length) return { hits: filtered, reranked: true };
  } catch (e) {
    console.error('[qa] rerank 降级为 BM25:', e.message);
  }
  return { hits, reranked: false };
}

function makeCitation(m) {
  return {
    id: m.id,
    date: msgDate(m),
    user: m.user,
    preview: (m.content || m.share?.title || '').slice(0, 60),
  };
}

const ZERO_HIT_HINT = (n) =>
  `范围内有 ${n} 条消息但关键词无命中。建议:1) 把长关键词拆成 2 字短词 2) 补充同义词/英文缩写 3) 用 count_messages 换关键词探测话题分布在哪些日期`;

// ─── 块级检索(主路径) ────────────────────────────────────────────────
// 检索单元是话题块(时间断层切分,见 lib/chat-chunks.js)而非单条短消息。
// 有 groupDir 且离线索引新鲜时,块文本前置 LLM 标注(主题/参与者/结论),
// BM25 与 rerank 都吃到语义信息;索引缺失/过期时即时切块(无标注)。
// 返回 null 表示应降级到单条路径(语料太小或块级零命中)。
async function searchByChunks({ msgs, keywords, query, config, question, ledger, personNote, dateFrom, dateTo, person, groupDir }) {
  const msgById = new Map(msgs.map(m => [String(m.id), m]));
  const toChunk = (msgIds, annotation, endTs) => {
    const present = msgIds.map(id => msgById.get(String(id))).filter(Boolean);
    return present.length ? { msgs: present, annotation, endTs: endTs || present[present.length - 1].timestamp || 0 } : null;
  };

  let chunks = [];
  if (groupDir) {
    const byDate = new Map();
    for (const m of msgs) {
      const d = msgDate(m);
      if (!d) continue;
      if (!byDate.has(d)) byDate.set(d, []);
      byDate.get(d).push(m);
    }
    const dates = [...byDate.keys()].sort();
    const { byDate: index } = loadChunkIndex(groupDir, dates);
    for (const d of dates) {
      const entry = index.get(d);
      const raw = entry?.chunks?.length
        ? entry.chunks.map(c => toChunk(c.msgIds, c.annotation || null, c.endTs))
        : buildChunksForMessages(byDate.get(d)).map(c => toChunk(c.msgIds, null, c.endTs));
      chunks.push(...raw.filter(Boolean));
    }
  } else {
    chunks = buildChunksForMessages(msgs).map(c => toChunk(c.msgIds, null, c.endTs)).filter(Boolean);
  }

  if (chunks.length < 2) return null; // 语料太小,块级检索无意义

  const chunkDocs = chunks.map(c => (c.annotation ? c.annotation + '\n' : '') + c.msgs.map(msgText).join('\n'));
  let hits = bm25Search(chunkDocs, query, { limit: 20 });
  if (!hits.length) return null;

  hits = applyTimeDecay(hits, i => chunks[i].endTs);
  // rerank 候选:标注优先(信息密度远高于随机截断);无标注块用块首消息,
  // 保证降级块在精排中不被系统性歧视
  const { hits: kept, reranked } = await rerankFilter(
    hits,
    i => (chunks[i].annotation || chunks[i].msgs.slice(0, 2).map(msgText).join(' ')).slice(0, 160),
    config, question
  );
  hits = kept.slice(0, 8);

  const snippets = [];
  const citations = [];
  for (const h of hits) {
    const c = chunks[h.idx];
    // 块内小 BM25 定位真正命中的消息(引用要指向消息,不是块)
    const inner = bm25Search(c.msgs.map(msgText), query, { limit: 2 });
    const hitIdxs = inner.length ? inner.map(x => x.idx) : [0];
    for (const i of hitIdxs.slice(0, 2)) citations.push(makeCitation(c.msgs[i]));

    // 块即上下文;超长块取首个命中 ±8 条,防吃 token
    let snippetMsgs = c.msgs;
    if (c.msgs.length > 30) {
      const center = hitIdxs[0];
      snippetMsgs = c.msgs.slice(Math.max(0, center - 8), center + 9);
    }
    const header = c.annotation ? `【话题标注】${c.annotation}\n` : '';
    snippets.push(header + snippetMsgs.map(formatMessage).join('\n'));
  }
  ledger.citations.push(...citations);
  ledger.searchHistory.push({ keywords, person, dateFrom, dateTo, matchCount: hits.length, chunked: true });
  ledger.totalMatches += hits.length;
  if (dateFrom || dateTo) ledger.dateRangeUsed = { from: dateFrom, to: dateTo };
  if (hits.length > 3) ledger.confidence = hits.length > 6 ? 'high' : 'medium';

  return {
    matchCount: hits.length,
    matchUnit: 'topic_chunk',
    totalInRange: msgs.length,
    reranked,
    dateRange: (dateFrom || dateTo) ? `${dateFrom || '?'} ~ ${dateTo || '?'}` : '全部',
    hitIds: citations.slice(0, 8),
    snippets,
    ...(personNote ? { personNote } : {}),
  };
}

// ─── 单条消息检索(兜底路径) ──────────────────────────────────────────
async function searchFlat({ msgs, keywords, query, config, question, ledger, personNote, dateFrom, dateTo, person }) {
  const docs = msgs.map(msgText);
  let hits = bm25Search(docs, query, { limit: 40 });

  if (hits.length === 0) {
    ledger.searchHistory.push({ keywords, person, dateFrom, dateTo, matchCount: 0 });
    return {
      matchCount: 0,
      totalInRange: msgs.length,
      hint: ZERO_HIT_HINT(msgs.length),
      ...(personNote ? { personNote } : {}),
    };
  }

  hits = applyTimeDecay(hits, i => msgs[i].timestamp).slice(0, 40);
  const { hits: kept, reranked } = await rerankFilter(hits, i => docs[i].slice(0, 160), config, question);
  hits = kept.slice(0, 15);

  // 命中点 → 动态上下文片段(合并重叠区间)
  const ranges = hits
    .map(h => expandContext(msgs, h.idx))
    .sort((a, b) => a[0] - b[0]);
  const merged = [];
  for (const r of ranges) {
    const last = merged[merged.length - 1];
    if (last && r[0] <= last[1]) last[1] = Math.max(last[1], r[1]);
    else merged.push([...r]);
  }
  const snippets = merged.slice(0, 8).map(([s, e]) => msgs.slice(s, e).map(formatMessage).join('\n'));

  // 真实引用:top 命中的消息 id/日期/预览。同时作为 hitIds 回给模型,
  // 供 get_context 按 id 下钻——模型无法从纯文本 snippets 得知消息 id。
  const citations = hits.slice(0, 8).map(h => makeCitation(msgs[h.idx]));
  ledger.citations.push(...citations);

  ledger.searchHistory.push({ keywords, person, dateFrom, dateTo, matchCount: hits.length });
  ledger.totalMatches += hits.length;
  if (dateFrom || dateTo) ledger.dateRangeUsed = { from: dateFrom, to: dateTo };
  if (hits.length > 5) ledger.confidence = hits.length > 12 ? 'high' : 'medium';

  return {
    matchCount: hits.length,
    matchUnit: 'message',
    totalInRange: msgs.length,
    reranked,
    dateRange: (dateFrom || dateTo) ? `${dateFrom || '?'} ~ ${dateTo || '?'}` : '全部',
    hitIds: citations,
    snippets,
    ...(personNote ? { personNote } : {}),
  };
}

async function executeTool(name, args, allMessages, ledger, config, question, opts) {
  if (name === 'count_messages') {
    const { person, dateFrom, dateTo } = args;
    const keywords = normalizeKeywords(args.keywords);
    const invalid = validateDateArgs(args);
    if (invalid) return invalid;

    let msgs = filterByDate(allMessages, dateFrom, dateTo);
    let personNote;
    if (person) {
      const p = String(person).toLowerCase();
      const byPerson = msgs.filter(m => String(m.user ?? '').toLowerCase().includes(p));
      if (byPerson.length > 0) msgs = byPerson;
      else personNote = `未找到发言人 "${person}",统计的是全部发言人`;
    }
    // 词面包含匹配(any-of):计数要可预测、可解释,不做相关性打分
    const kws = keywords.map(k => String(k).toLowerCase()).filter(Boolean);
    if (kws.length) {
      msgs = msgs.filter(m => {
        const text = ((m.content || '') + ' ' + (m.share?.title || '')).toLowerCase();
        return kws.some(k => text.includes(k));
      });
    }

    const byDate = new Map();
    for (const m of msgs) {
      const d = msgDate(m);
      if (d) byDate.set(d, (byDate.get(d) || 0) + 1);
    }
    let groups = [...byDate.entries()].map(([key, count]) => ({ key, count }));
    groups.sort((a, b) => b.count - a.count);
    const truncated = groups.length > 40;
    groups = groups.slice(0, 40).sort((a, b) => (a.key < b.key ? -1 : 1));

    ledger.searchHistory.push({ count: true, keywords, person, dateFrom, dateTo, total: msgs.length });
    return {
      total: msgs.length,
      groups,
      truncated,
      dateSpan: dateSpanOf(allMessages),
      ...(personNote ? { personNote } : {}),
      ...(msgs.length === 0 ? { hint: kws.length ? '没有消息包含这些关键词。建议:换更短的词(2字)或同义词后重试' : '该条件下没有任何消息' } : {}),
    };
  }

  if (name === 'get_context') {
    const { messageId, span } = args;
    const maxSpan = Math.min(Math.max(Number(span) || 24, 4), 60);
    const idx = allMessages.findIndex(m => String(m.id) === String(messageId));
    if (idx === -1) {
      return { found: false, hint: `消息 id "${messageId}" 不存在。messageId 必须来自 search_messages 返回的 hitIds,不要自行构造` };
    }
    const [start, end] = expandContext(allMessages, idx, { maxSpan });
    const slice = allMessages.slice(start, end);
    const m = allMessages[idx];
    ledger.citations.push({
      id: m.id,
      date: msgDate(m),
      user: m.user,
      preview: (m.content || m.share?.title || '').slice(0, 60),
    });
    ledger.searchHistory.push({ context: true, messageId });
    return {
      found: true,
      range: { from: msgDate(slice[0]), to: msgDate(slice[slice.length - 1]), count: slice.length },
      messages: slice.map(formatMessage),
    };
  }

  if (name === 'search_messages') {
    const { person, dateFrom, dateTo } = args;
    const keywords = normalizeKeywords(args.keywords);
    const invalid = validateDateArgs(args);
    if (invalid) return invalid;

    let msgs = filterByDate(allMessages, dateFrom, dateTo);
    let personNote;
    if (person) {
      const p = String(person).toLowerCase();
      const byPerson = msgs.filter(m => String(m.user ?? '').toLowerCase().includes(p));
      // 有匹配者按人筛选;没有则保留全量(人名可能记错,让关键词兜底)并显式告知
      if (byPerson.length > 0) msgs = byPerson;
      else personNote = `未找到发言人 "${person}",已在全部发言人中搜索`;
    }

    const span = dateSpanOf(allMessages);
    if (msgs.length === 0) {
      ledger.searchHistory.push({ keywords, person, dateFrom, dateTo, matchCount: 0 });
      return {
        matchCount: 0,
        totalInRange: 0,
        hint: `日期范围 ${dateFrom || '?'} ~ ${dateTo || '?'} 内没有任何消息。可用的日期范围是 ${span?.first} ~ ${span?.last}`,
      };
    }

    const query = keywords.join(' ');
    const common = { msgs, keywords, query, config, question, ledger, personNote, dateFrom, dateTo, person };

    // 话题块级检索优先(检索单元是话题串而非单条短消息,BM25 更稳;
    // 有离线标注时块文本还带 LLM 生成的主题/结论,跨过词汇鸿沟)
    const chunkResult = await searchByChunks({ ...common, groupDir: opts?.groupDir });
    if (chunkResult) return chunkResult;

    // 兜底:单条消息 BM25(块级零命中或语料太小时)
    return searchFlat(common);
  }

  if (name === 'get_recent_messages') {
    const { dateFrom, dateTo, limit } = args;
    const invalid = validateDateArgs(args);
    if (invalid) return invalid;
    const maxCount = Math.min(limit || 120, 200);
    const msgs = filterByDate(allMessages, dateFrom, dateTo);
    if (msgs.length === 0) {
      const span = dateSpanOf(allMessages);
      return { total: 0, returned: 0, hint: `日期范围 ${dateFrom} ~ ${dateTo} 内没有任何消息。可用的日期范围是 ${span?.first} ~ ${span?.last}` };
    }
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
async function conversationLoop(question, allMessages, config, opts) {
  const budget = new IterationBudget(6);
  const state = new AgentState();
  const ledger = createLedger();
  const toolCallLog = [];

  state.transition('running');

  const today = new Date().toISOString().split('T')[0];
  const systemPrompt = `你是一个群聊记录问答助手。今天是 ${today}。

先判断问题类型,选对工具:

【事实检索型】"X 说了什么"、"谁提到过 Y"、"关于 Z 的讨论"
→ 用 search_messages。关键词同时给同义词/英文缩写(问"大模型"→ ["大模型","LLM","GPT","AI"])。
→ 片段信息不足以回答时,用 get_context 按 hitIds 里的消息 id 拉完整对话。

【总结归纳型】"大家在聊什么"、"总结一下"、"最近有什么话题"、"聊天氛围如何"
→ 直接用 get_recent_messages 读取该时间段记录后归纳。不要用关键词搜索——总结不需要检索。

搜索策略(先宽后窄):
- 不确定话题发生在什么时候 → 先用 count_messages(不限日期)探测该话题分布在哪些日期,再把 search_messages 锁定到热点日期。
- 先用宽泛的短关键词起步,根据结果逐步收窄;不要一上来就用长而具体的词组。
- 零命中不是终点:工具返回的 hint 会告诉你怎么调整(拆词/换同义词/扩日期),按提示重试,不要轻易放弃。
- 结果里的 personNote / hint 字段是给你的操作提示,务必据此修正下一步调用。

回答要求:
- 只基于聊天记录回答,不要编造
- 引用具体发言人和日期
- 找不到相关信息时明确告知
- 用中文回答

时间理解:
- "昨天" = ${new Date(Date.now() - 86400000).toISOString().split('T')[0]}
- "前天" = ${new Date(Date.now() - 172800000).toISOString().split('T')[0]}
- "最近" = 最近7天 (${new Date(Date.now() - 7 * 86400000).toISOString().split('T')[0]} ~ ${today})
- "上周" = 上一个完整周(周一到周日)`;

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
    // 60s:总结型问题携带 200 条消息生成最终回答,30s 会误杀(baseline q15)
    const assistantMsg = await withRetry(
      () => withTimeout(callLLM(config, messages), 60000),
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
      const result = await executeTool(tc.function.name, args, allMessages, ledger, config, question, opts);

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
// executeTool / expandContext 仅为单测导出
export { executeTool, expandContext };

export async function askAgent(question, allMessages, aiConfigOverride, opts = {}) {
  const aiConfig = aiConfigOverride || loadAiConfig();
  if (!aiConfig) return { ok: false, error: 'AI 未配置' };

  try {
    const result = await conversationLoop(question, allMessages, aiConfig, opts);

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
