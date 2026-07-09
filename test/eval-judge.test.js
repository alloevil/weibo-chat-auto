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
