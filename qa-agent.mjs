import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

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
      description: '在群聊记录中搜索关键词。返回匹配的消息片段及其上下文。可以多次调用以用不同关键词搜索。',
      parameters: {
        type: 'object',
        properties: {
          keywords: { type: 'array', items: { type: 'string' }, description: '搜索关键词列表' },
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
      description: '获取某个时间段内的最新消息（不做关键词筛选，直接返回原始记录）。用于浏览某段时间的聊天内容。',
      parameters: {
        type: 'object',
        properties: {
          dateFrom: { type: 'string', description: '起始日期 YYYY-MM-DD' },
          dateTo: { type: 'string', description: '结束日期 YYYY-MM-DD' },
          limit: { type: 'number', description: '最多返回条数，默认30' },
        },
        required: ['dateFrom', 'dateTo'],
        additionalProperties: false,
      },
    },
  },
];

// ─── Tool execution ────────────────────────────────────────────────────
function executeTool(name, args, allMessages, ledger) {
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

    const scored = [];
    for (let i = 0; i < msgs.length; i++) {
      const m = msgs[i];
      const text = (m.user || '') + ' ' + (m.content || '') + ' ' + (m.share?.title || '');
      let score = 0;
      if (person && (m.user || '').toLowerCase().includes(person.toLowerCase())) score += 3;
      for (const kw of keywords) {
        if (text.toLowerCase().includes(kw.toLowerCase())) score++;
      }
      if (score > 0) scored.push({ idx: i, score });
    }

    scored.sort((a, b) => b.score - a.score);
    const topHits = scored.slice(0, 15);

    const segments = new Set();
    const chunks = [];
    for (const hit of topHits) {
      const start = Math.max(0, hit.idx - 3);
      const end = Math.min(msgs.length, hit.idx + 4);
      const segKey = `${start}-${end}`;
      if (segments.has(segKey)) continue;
      let skip = false;
      for (const existing of segments) {
        const [es, ee] = existing.split('-').map(Number);
        if (start >= es && end <= ee) { skip = true; break; }
      }
      if (skip) continue;
      segments.add(segKey);
      chunks.push(msgs.slice(start, end).map(formatMessage).join('\n'));
    }

    ledger.searchHistory.push({ keywords, person, dateFrom, dateTo, matchCount: scored.length });
    ledger.totalMatches += scored.length;
    if (dateFrom || dateTo) ledger.dateRangeUsed = { from: dateFrom, to: dateTo };
    if (scored.length > 5) ledger.confidence = scored.length > 20 ? 'high' : 'medium';

    return {
      matchCount: scored.length,
      totalInRange: msgs.length,
      dateRange: (dateFrom || dateTo) ? `${dateFrom || '?'} ~ ${dateTo || '?'}` : '全部',
      snippets: chunks.slice(0, 8),
    };
  }

  if (name === 'get_recent_messages') {
    const { dateFrom, dateTo, limit } = args;
    const maxCount = limit || 30;
    const msgs = allMessages.filter(m => {
      const d = (m.time || '').split(' ')[0].replace(/\//g, '-');
      if (!d) return false;
      if (dateFrom && d < dateFrom) return false;
      if (dateTo && d > dateTo) return false;
      return true;
    });
    const sample = msgs.slice(-maxCount);
    ledger.searchHistory.push({ browse: true, dateFrom, dateTo, total: msgs.length });
    if (dateFrom || dateTo) ledger.dateRangeUsed = { from: dateFrom, to: dateTo };
    return { total: msgs.length, returned: sample.length, messages: sample.map(formatMessage) };
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

你可以使用工具搜索群聊历史记录来回答用户的问题。使用迭代搜索策略：

策略：
1. 分析问题 → 确定关键词、人名、时间范围
2. 执行搜索 → 评估结果是否充分
3. 如果结果不够 → 换关键词/扩大范围再搜
4. 获取足够信息后 → 生成回答

回答要求：
- 只基于搜索到的聊天记录回答，不要编造
- 引用具体发言人和日期
- 如果找不到相关信息，明确告知
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
      const result = executeTool(tc.function.name, args, allMessages, ledger);

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
export async function askAgent(question, allMessages) {
  const aiConfig = loadAiConfig();
  if (!aiConfig) return { ok: false, error: 'AI 未配置' };

  try {
    const result = await conversationLoop(question, allMessages, aiConfig);

    const keywords = [...new Set(result.toolCallLog.flatMap(tc => tc.keywords || []))];
    const sources = result.toolCallLog
      .filter(tc => tc.dateFrom || tc.dateTo)
      .map(tc => ({ date: tc.dateFrom || tc.dateTo || '', preview: `${tc.matchCount ?? tc.total ?? 0} 条匹配` }));

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
