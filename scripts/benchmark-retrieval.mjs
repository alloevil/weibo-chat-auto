import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { performance } from 'node:perf_hooks';
import { createHash } from 'node:crypto';
import { retrievalCases } from '../test/fixtures/qa-retrieval-cases.mjs';

const option = (name) => {
    const index = process.argv.indexOf(name);
    return index < 0 ? null : process.argv[index + 1];
};
const baselineRoot = option('--baseline-root');
const roots = baselineRoot
    ? [
          ['baseline', path.resolve(baselineRoot)],
          ['current', path.resolve(import.meta.dirname, '..')],
      ]
    : [['current', path.resolve(import.meta.dirname, '..')]];
const report = {
    kind: 'synthetic retrieval stress cases; no answer model, no reranker calls; not a real-world accuracy benchmark',
    cases: retrievalCases().length,
    datasetSha256: createHash('sha256').update(JSON.stringify(retrievalCases())).digest('hex'),
    budgets: {
        chunkCandidates: 20,
        messageCandidates: 40,
        chunksReturned: 8,
        longChunkMessages: 17,
    },
    timingCaveat:
        'One offline pass per implementation, no model/network latency; not a speedup benchmark.',
    runs: [],
};
for (const [label, root] of roots) {
    const { executeTool } = await import(
        pathToFileURL(path.join(root, 'scripts/qa-agent.mjs')).href
    );
    const rows = [];
    for (const sample of retrievalCases()) {
        const ledger = {
            facts: [],
            searchHistory: [],
            citations: [],
            totalMatches: 0,
            dateRangeUsed: null,
            confidence: 'low',
        };
        const started = performance.now();
        const result = await executeTool(
            'search_messages',
            sample.args,
            sample.messages,
            ledger,
            null,
            sample.question
        );
        const elapsedMs = performance.now() - started;
        const observed = new Set(ledger.citations.map((citation) => String(citation.id)));
        const found = sample.gold.filter((id) => observed.has(id)).length;
        rows.push({
            id: sample.id,
            category: sample.category,
            requiredEvidence: sample.gold.length,
            foundEvidence: found,
            pass: sample.gold.length ? found === sample.gold.length : result.matchCount === 0,
            elapsedMs: Number(elapsedMs.toFixed(3)),
            snippetChars: (result.snippets || []).join('\n').length,
            trace: ledger.retrievalTrace || [],
        });
    }
    const timings = rows.map((row) => row.elapsedMs).sort((left, right) => left - right);
    const required = rows.reduce((total, row) => total + row.requiredEvidence, 0);
    const found = rows.reduce((total, row) => total + row.foundEvidence, 0);
    const run = {
        label,
        passingCases: rows.filter((row) => row.pass).length,
        totalCases: rows.length,
        evidenceFound: found,
        evidenceRequired: required,
        evidenceCoverage: found / required,
        p50Ms: timings[Math.floor(timings.length * 0.5)],
        p95Ms: timings[Math.floor(timings.length * 0.95)],
        modelCalls: 0,
        categories: {},
        rows,
    };
    for (const category of new Set(rows.map((row) => row.category))) {
        const subset = rows.filter((row) => row.category === category);
        run.categories[category] = {
            passed: subset.filter((row) => row.pass).length,
            total: subset.length,
        };
    }
    report.runs.push(run);
    console.log(JSON.stringify({ ...run, rows: undefined }, null, 2));
}
const output = option('--output');
if (output) fs.writeFileSync(output, JSON.stringify(report, null, 2) + '\n');
