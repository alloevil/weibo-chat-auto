const { test } = require('node:test');
const assert = require('node:assert');

async function load() {
  return import('../eval/run-eval.mjs');
}

test('efficiencyScore: 2 次调用满分,6 次归零,越界截断', async () => {
  const { efficiencyScore } = await load();
  assert.strictEqual(efficiencyScore(1), 1);
  assert.strictEqual(efficiencyScore(2), 1);
  assert.strictEqual(efficiencyScore(4), 0.5);
  assert.strictEqual(efficiencyScore(6), 0);
  assert.strictEqual(efficiencyScore(10), 0);
});

test('computeOverall: 加权公式', async () => {
  const { computeOverall } = await load();
  assert.ok(Math.abs(computeOverall({ factual: 1, grounded: 1, complete: 1, efficiency: 1 }) - 1) < 1e-9);
  const v = computeOverall({ factual: 0.5, grounded: 1, complete: 0, efficiency: 1 });
  assert.ok(Math.abs(v - (0.2 + 0.3 + 0 + 0.1)) < 1e-9);
});

test('parseJudgeResponse: 抓 JSON 块,校验 0-1 范围', async () => {
  const { parseJudgeResponse } = await load();
  const r = parseJudgeResponse('评分如下:\n{"factual": 0.8, "grounded": 1, "complete": 0.5, "reasoning": "ok"}');
  assert.strictEqual(r.factual, 0.8);
  assert.strictEqual(r.grounded, 1);
  assert.strictEqual(r.reasoning, 'ok');
  assert.throws(() => parseJudgeResponse('没有 JSON'));
  assert.throws(() => parseJudgeResponse('{"factual": 2, "grounded": 1, "complete": 1}'));
  assert.throws(() => parseJudgeResponse('{"factual": 0.5, "grounded": 1}')); // 缺 complete
});

test('checkMustMention: 大小写不敏感的包含校验', async () => {
  const { checkMustMention } = await load();
  assert.strictEqual(checkMustMention('推荐了 KayingCodex 工具', ['kayingcodex']), true);
  assert.strictEqual(checkMustMention('没提到', ['KayingCodex']), false);
  assert.strictEqual(checkMustMention('任意回答', undefined), true);
  assert.strictEqual(checkMustMention('任意回答', []), true);
});

test('buildJudgePrompt: 无 goldenFacts 时指示 factual=grounded', async () => {
  const { buildJudgePrompt } = await load();
  const withGolden = buildJudgePrompt({ question: 'q', answer: 'a', sources: [], goldenFacts: ['事实1'] });
  assert.match(withGolden, /事实1/);
  const without = buildJudgePrompt({ question: 'q', answer: 'a', sources: [{ date: 'd', user: 'u', preview: 'p' }] });
  assert.match(without, /factual 请给出与 grounded 相同的分数/);
  assert.match(without, /\[d\] u: p/);
});

test('summarize: 平均/分类聚合,judgeError 不进平均', async () => {
  const { summarize } = await load();
  const s = summarize([
    { id: 'a', category: 'fact', overall: 1, elapsed: 1000, llmCalls: 2 },
    { id: 'b', category: 'fact', overall: 0.5, elapsed: 3000, llmCalls: 4 },
    { id: 'c', category: 'summary', judgeError: 'x', elapsed: 2000, llmCalls: 3 },
    { id: 'd', category: 'summary', error: 'boom', elapsed: 100 },
  ]);
  assert.strictEqual(s.avgOverall, 0.75);
  assert.strictEqual(s.avgByCategory.fact, 0.75);
  assert.strictEqual(s.avgByCategory.summary, undefined);
  assert.strictEqual(s.failures, 1);
  assert.strictEqual(s.judgeErrors, 1);
  assert.strictEqual(s.avgLlmCalls, 3);
});

test('formatReport: 对比模式输出 Δ', async () => {
  const { formatReport, summarize } = await load();
  const mk = (overall) => ({
    label: 'x', perQuestion: [{ id: 'q01', category: 'fact', overall, scores: { factual: overall, grounded: overall, complete: overall, efficiency: 1 }, elapsed: 1000, llmCalls: 2, mustMentionPass: true }],
    summary: summarize([{ id: 'q01', category: 'fact', overall, elapsed: 1000, llmCalls: 2 }]),
  });
  const report = formatReport(mk(0.8), mk(0.6));
  assert.match(report, /\+0\.20/);
  assert.match(report, /Δ avgOverall: 0\.200/);
});

test('judgeAnswer: 请求形状（端点/鉴权/模型/prompt）与响应解析', async () => {
  const { judgeAnswer, buildJudgePrompt, parseJudgeResponse } = await load();
  const orig = global.fetch;
  try {
    const content = '{"factual":1,"grounded":0.5,"complete":1,"reasoning":"引用完整"}';
    const judgeArgs = { question: '问', answer: '答', sources: [{ date: '2026-07-03', user: 'tk', preview: '半导体还没跌到位' }], goldenFacts: ['没跌到位'] };
    let captured;
    global.fetch = async (url, init) => {
      captured = { url: String(url), init };
      return { ok: true, json: async () => ({ choices: [{ message: { content } }] }) };
    };
    const scores = await judgeAnswer({ baseUrl: 'https://llm.test/v1', apiKey: 'sk-k', model: 'gpt-x' }, judgeArgs);

    assert.strictEqual(captured.url, 'https://llm.test/v1/chat/completions');
    assert.strictEqual(captured.init.headers['Authorization'], 'Bearer sk-k');
    const body = JSON.parse(captured.init.body);
    assert.strictEqual(body.model, 'gpt-x');
    assert.strictEqual(body.stream, false);
    // prompt 必须由 buildJudgePrompt 生成（含问题/来源/标准事实）
    assert.strictEqual(body.messages[0].content, buildJudgePrompt(judgeArgs));
    // 返回值必须等价于对 content 的解析结果（content 提取路径断了会在此暴露）
    assert.deepStrictEqual(scores, parseJudgeResponse(content));
  } finally {
    global.fetch = orig;
  }
});

test('judgeAnswer: 非 200 抛错并带状态码', async () => {
  const { judgeAnswer } = await load();
  const orig = global.fetch;
  try {
    global.fetch = async () => ({ ok: false, status: 503 });
    await assert.rejects(
      () => judgeAnswer({ baseUrl: 'x', apiKey: 'k', model: 'm' }, { question: 'q', answer: 'a', sources: [], goldenFacts: [] }),
      /503/
    );
  } finally {
    global.fetch = orig;
  }
});
