// QA 评测 runner:直接调 askAgent(不走 HTTP),LLM-as-judge 打分,支持前后对比。
//
// 用法:
//   node eval/run-eval.mjs --label baseline
//   node eval/run-eval.mjs --label step2 --compare eval/results/<ts>-baseline.json
//   node eval/run-eval.mjs --label x --only q01,q13
//
// 评分:overall = 0.4*factual + 0.3*grounded + 0.2*complete + 0.1*efficiency
//   - factual/grounded/complete 由 judge LLM 单次调用给出(0-1)
//   - efficiency 机械计算,不进 judge:clamp(1-(llmCalls-2)/4, 0, 1)
//   - judge 失败记 judgeError,不算 0 分、不进平均(避免网络抖动污染对比)
import fs from 'fs';
import path from 'path';
import { fileURLToPath, pathToFileURL } from 'url';
import { createRequire } from 'module';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');
const require = createRequire(import.meta.url);

// ─── 可测试的纯函数 ─────────────────────────────────────────────────────

export function efficiencyScore(llmCalls) {
  return Math.max(0, Math.min(1, 1 - (llmCalls - 2) / 4));
}

export function computeOverall({ factual, grounded, complete, efficiency }) {
  return 0.4 * factual + 0.3 * grounded + 0.2 * complete + 0.1 * efficiency;
}

/** 从 judge 回复中提取严格 JSON。失败抛错(调用方记 judgeError)。 */
export function parseJudgeResponse(text) {
  const m = String(text).match(/\{[\s\S]*\}/);
  if (!m) throw new Error('judge: no JSON object in response');
  const obj = JSON.parse(m[0]);
  for (const k of ['factual', 'grounded', 'complete']) {
    const v = Number(obj[k]);
    if (!(v >= 0 && v <= 1)) throw new Error(`judge: invalid ${k}=${obj[k]}`);
    obj[k] = v;
  }
  obj.reasoning = String(obj.reasoning || '');
  return obj;
}

export function checkMustMention(answer, mustMention) {
  if (!mustMention?.length) return true;
  const a = String(answer).toLowerCase();
  return mustMention.every(s => a.includes(String(s).toLowerCase()));
}

export function buildJudgePrompt({ question, answer, sources, goldenFacts }) {
  const sourceList = (sources || [])
    .map(s => `- [${s.date}] ${s.user}: ${s.preview}`)
    .join('\n') || '(无引用)';
  const goldenBlock = goldenFacts?.length
    ? `【标准事实】(评 factual 的依据,回答应包含或不与之矛盾):\n${goldenFacts.map(f => `- ${f}`).join('\n')}`
    : `【标准事实】未提供。此时 factual 请给出与 grounded 相同的分数。`;
  return `你是问答质量评审。请针对下面的群聊问答打分,只输出一个 JSON 对象,不要其他文字。

【用户问题】
${question}

【系统回答】
${answer}

【系统给出的引用来源】
${sourceList}

${goldenBlock}

请评分(均为 0 到 1 的小数):
- factual: 事实准确性。回答内容是否与标准事实一致;编造、张冠李戴、关键事实错误应低分。
- grounded: 论断支撑度。回答中的论断是否能被引用来源支撑;引用与回答无关或缺引用的关键论断应扣分。
- complete: 完整性。是否正面回应了问题的全部要点;答非所问或明显遗漏应扣分。若回答如实说明"未找到相关记录"且引用确实不含相关内容,complete 给 0.5。

输出格式:{"factual": 0.0, "grounded": 0.0, "complete": 0.0, "reasoning": "一两句中文说明扣分点"}`;
}

/** 生成 markdown 汇总表与(可选)对比 Δ 表。 */
export function formatReport(result, baseline) {
  const lines = [];
  const basePer = baseline ? Object.fromEntries(baseline.perQuestion.map(p => [p.id, p])) : null;
  lines.push('| id | cat | overall | factual | grounded | complete | eff | mm | llm | s |' + (basePer ? ' Δoverall |' : ''));
  lines.push('|---|---|---|---|---|---|---|---|---|---|' + (basePer ? '---|' : ''));
  for (const p of result.perQuestion) {
    const f = n => (n == null ? '—' : n.toFixed(2));
    let delta = '';
    if (basePer) {
      const b = basePer[p.id];
      delta = (b && b.overall != null && p.overall != null) ? ` ${(p.overall - b.overall) >= 0 ? '+' : ''}${(p.overall - b.overall).toFixed(2)} |` : ' — |';
    }
    lines.push(`| ${p.id} | ${p.category} | ${f(p.overall)} | ${f(p.scores?.factual)} | ${f(p.scores?.grounded)} | ${f(p.scores?.complete)} | ${f(p.scores?.efficiency)} | ${p.mustMentionPass === false ? '✗' : '✓'} | ${p.llmCalls ?? '—'} | ${(p.elapsed / 1000).toFixed(1)} |` + delta);
  }
  const s = result.summary;
  lines.push('');
  lines.push(`avgOverall: ${s.avgOverall?.toFixed(3)}  avgElapsed: ${(s.avgElapsed / 1000).toFixed(1)}s  avgLlmCalls: ${s.avgLlmCalls?.toFixed(1)}  failures: ${s.failures}  judgeErrors: ${s.judgeErrors}`);
  if (baseline) {
    lines.push(`Δ avgOverall: ${(s.avgOverall - baseline.summary.avgOverall).toFixed(3)} (baseline ${baseline.summary.avgOverall?.toFixed(3)} → ${s.avgOverall?.toFixed(3)})`);
  }
  const byCat = Object.entries(s.avgByCategory || {}).map(([k, v]) => `${k}=${v.toFixed(2)}`).join(' ');
  lines.push(`byCategory: ${byCat}`);
  return lines.join('\n');
}

export function summarize(perQuestion) {
  const judged = perQuestion.filter(p => p.overall != null);
  const avg = arr => arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : null;
  const byCat = {};
  for (const p of judged) (byCat[p.category] ||= []).push(p.overall);
  return {
    avgOverall: avg(judged.map(p => p.overall)),
    avgByCategory: Object.fromEntries(Object.entries(byCat).map(([k, v]) => [k, avg(v)])),
    avgElapsed: avg(perQuestion.map(p => p.elapsed)),
    avgLlmCalls: avg(perQuestion.filter(p => p.llmCalls != null).map(p => p.llmCalls)),
    failures: perQuestion.filter(p => p.error).length,
    judgeErrors: perQuestion.filter(p => p.judgeError).length,
  };
}

// ─── judge 调用 ─────────────────────────────────────────────────────────

async function judgeAnswer(config, args) {
  const resp = await fetch(`${config.baseUrl}/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${config.apiKey}` },
    body: JSON.stringify({
      model: config.model,
      messages: [{ role: 'user', content: buildJudgePrompt(args) }],
      stream: false,
    }),
  });
  if (!resp.ok) throw new Error(`judge API ${resp.status}`);
  const data = await resp.json();
  return parseJudgeResponse(data.choices?.[0]?.message?.content || '');
}

// ─── main ───────────────────────────────────────────────────────────────

async function main() {
  const args = process.argv.slice(2);
  const opt = (name, def) => {
    const i = args.indexOf(`--${name}`);
    return i !== -1 ? args[i + 1] : def;
  };
  const label = opt('label', 'run');
  const comparePath = opt('compare', null);
  const only = opt('only', null)?.split(',');

  const spec = JSON.parse(fs.readFileSync(path.join(__dirname, 'questions.json'), 'utf-8'));
  const aiConfig = JSON.parse(fs.readFileSync(path.join(ROOT, 'ai-config.json'), 'utf-8'));
  const { loadMessages, getGroupDir } = require(path.join(ROOT, 'lib/load-messages.js'));
  const { askAgent } = await import(pathToFileURL(path.join(ROOT, 'qa-agent.mjs')).href);

  const outputDir = path.join(ROOT, 'output');
  const allMessages = loadMessages(outputDir, spec.group);
  const groupDir = getGroupDir(outputDir, spec.group);
  if (!allMessages.length) {
    console.error(`没有找到群 "${spec.group}" 的归档数据`);
    process.exit(1);
  }
  console.log(`群: ${spec.group}  消息: ${allMessages.length}  模型: ${aiConfig.model}  label: ${label}`);

  const questions = spec.questions.filter(q => !only || only.includes(q.id));
  const perQuestion = [];

  for (const q of questions) {
    process.stdout.write(`[${q.id}] ${q.question.slice(0, 30)}... `);
    const t0 = Date.now();
    let entry = { id: q.id, category: q.category, question: q.question };
    try {
      const res = await askAgent(q.question, allMessages, aiConfig, { groupDir });
      entry.elapsed = Date.now() - t0;
      if (!res.ok) throw new Error(res.error);
      entry.answer = res.answer;
      entry.sources = res.sources;
      entry.toolCalls = res.toolCalls;
      // steps 含 llm_call + tool_call,两者相减得 LLM 调用次数
      entry.llmCalls = Math.max(1, (res.steps || 0) - (res.toolCalls?.length || 0));
      entry.mustMentionPass = checkMustMention(res.answer, q.mustMention);

      try {
        const scores = await judgeAnswer(aiConfig, {
          question: q.question, answer: res.answer, sources: res.sources, goldenFacts: q.goldenFacts,
        });
        const efficiency = efficiencyScore(entry.llmCalls);
        entry.scores = { ...scores, efficiency };
        entry.judgeReasoning = scores.reasoning;
        entry.overall = computeOverall({ ...scores, efficiency });
      } catch (je) {
        entry.judgeError = je.message;
      }
      process.stdout.write(`overall=${entry.overall?.toFixed(2) ?? 'judge失败'} (${(entry.elapsed / 1000).toFixed(1)}s)\n`);
    } catch (e) {
      entry.elapsed = Date.now() - t0;
      entry.error = e.message;
      process.stdout.write(`失败: ${e.message}\n`);
    }
    perQuestion.push(entry);
  }

  const result = {
    label,
    ranAt: new Date().toISOString(),
    model: aiConfig.model,
    group: spec.group,
    questionsVersion: spec.version,
    perQuestion,
    summary: summarize(perQuestion),
  };

  const resultsDir = path.join(__dirname, 'results');
  fs.mkdirSync(resultsDir, { recursive: true });
  const outFile = path.join(resultsDir, `${result.ranAt.replace(/[:.]/g, '-')}-${label}.json`);
  fs.writeFileSync(outFile, JSON.stringify(result, null, 2));

  const baseline = comparePath ? JSON.parse(fs.readFileSync(comparePath, 'utf-8')) : null;
  console.log('\n' + formatReport(result, baseline));
  console.log(`\n结果已存: ${outFile}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(e => { console.error(e); process.exit(1); });
}
