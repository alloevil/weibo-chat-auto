const BASE = 'http://localhost:3456';
const GROUP = '茧房建筑师协会';

const questions = [
  '最近tk说了什么',
  '昨天有讨论投资吗',
  '群里谁在讨论AI',
  '上周有人分享过什么链接',
  '最近大家在聊什么话题',
];

async function runQuery(question, mode) {
  const start = Date.now();
  const resp = await fetch(`${BASE}/api/qa`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ group: GROUP, question, mode }),
  });
  const data = await resp.json();
  const elapsed = Date.now() - start;
  return { ...data, elapsed, mode };
}

async function benchmark() {
  console.log('=== Q&A Benchmark: Agent vs Legacy ===\n');
  console.log(`Group: ${GROUP}`);
  console.log(`Questions: ${questions.length}\n`);

  const results = [];

  for (const q of questions) {
    console.log(`\n--- 问题: "${q}" ---`);

    // Run agent mode
    console.log('  [Agent] 运行中...');
    const agent = await runQuery(q, 'agent');
    console.log(`  [Agent] ${agent.elapsed}ms | ${agent.ok ? '成功' : '失败: ' + agent.error}`);
    if (agent.ok) {
      console.log(`  [Agent] 步骤: ${agent.steps || '?'} | 工具调用: ${JSON.stringify(agent.toolCalls?.map(t => t.tool) || [])}`);
      console.log(`  [Agent] 答案前100字: ${(agent.answer || '').slice(0, 100)}`);
    }

    // Run legacy mode
    console.log('  [Legacy] 运行中...');
    const legacy = await runQuery(q, 'legacy');
    console.log(`  [Legacy] ${legacy.elapsed}ms | ${legacy.ok ? '成功' : '失败: ' + legacy.error}`);
    if (legacy.ok) {
      console.log(`  [Legacy] 关键词: ${JSON.stringify(legacy.keywords)} | 日期范围: ${JSON.stringify(legacy.dateRange)}`);
      console.log(`  [Legacy] 答案前100字: ${(legacy.answer || '').slice(0, 100)}`);
    }

    results.push({ question: q, agent, legacy });
  }

  // Summary
  console.log('\n\n=== 汇总 ===\n');
  console.log('| 问题 | Agent(ms) | Legacy(ms) | Agent步骤 | 结果 |');
  console.log('|------|-----------|------------|-----------|------|');
  for (const r of results) {
    const agentOk = r.agent.ok ? '✓' : '✗';
    const legacyOk = r.legacy.ok ? '✓' : '✗';
    console.log(`| ${r.question.slice(0, 12)} | ${r.agent.elapsed} | ${r.legacy.elapsed} | ${r.agent.steps || '-'} | A:${agentOk} L:${legacyOk} |`);
  }

  const agentAvg = Math.round(results.reduce((s, r) => s + r.agent.elapsed, 0) / results.length);
  const legacyAvg = Math.round(results.reduce((s, r) => s + r.legacy.elapsed, 0) / results.length);
  console.log(`\n平均延迟: Agent ${agentAvg}ms | Legacy ${legacyAvg}ms`);
  console.log(`Agent 成功率: ${results.filter(r => r.agent.ok).length}/${results.length}`);
  console.log(`Legacy 成功率: ${results.filter(r => r.legacy.ok).length}/${results.length}`);
}

benchmark().catch(console.error);
