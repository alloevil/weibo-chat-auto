import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { performance } from 'node:perf_hooks';
import { retrievalCases } from '../test/fixtures/qa-retrieval-cases.mjs';
import { retrievalValidationCases } from '../test/fixtures/qa-retrieval-validation.mjs';

const option = (name) => {
    const index = process.argv.indexOf(name);
    return index < 0 ? null : process.argv[index + 1];
};
const root = path.resolve(import.meta.dirname, '..');
const samples = [
    ...retrievalCases().map((sample) => ({ ...sample, suite: 'mechanism' })),
    ...retrievalValidationCases().map((sample) => ({ ...sample, suite: 'validation' })),
];
const arm = option('--arm');
const arms = [
    'current',
    'keywords-only',
    'raw-question',
    'unconditional-time',
    'head-preview',
    'single-window',
];
const baselineRoot = option('--baseline-root');
if (arm) {
    if (![...arms, 'baseline'].includes(arm)) throw new Error(`Unknown arm: ${arm}`);
    const targetRoot = arm === 'baseline' ? path.resolve(baselineRoot) : root;
    if (arm !== 'baseline') {
        const { default: policy } = await import('../lib/retrieval-policy.js');
        if (arm === 'keywords-only') policy.retrievalQueries = (query) => (query ? [query] : []);
        if (arm === 'raw-question') {
            const { default: lexical } = await import('../lib/search-bm25.js');
            policy.retrievalQueries = (query, question, keywords = []) => {
                const seen = new Set();
                return [query, question, ...keywords.slice(0, 2)]
                    .map((value) =>
                        String(value || '')
                            .trim()
                            .slice(0, 512)
                    )
                    .filter((value) => {
                        const signature = [...new Set(lexical.tokenize(value))]
                            .sort()
                            .join('\u0000');
                        if (!signature || seen.has(signature)) return false;
                        seen.add(signature);
                        return true;
                    });
            };
        }
        if (arm === 'unconditional-time') policy.recentQuery = () => true;
        if (arm === 'head-preview') {
            policy.rerankExcerpt = (messages, _anchors, _query, format) =>
                messages.slice(0, 2).map(format).join(' ').slice(0, 120);
            policy.hitExcerpt = (text) => String(text).slice(0, 120);
        }
        if (arm === 'single-window')
            policy.evidenceIndexes = (length, anchors) => {
                const center = anchors[0] ?? 0;
                return Array.from({ length }, (_, index) => index).filter(
                    (index) => index >= center - 8 && index <= center + 8
                );
            };
    }
    const { executeTool } = await import(
        pathToFileURL(path.join(targetRoot, 'scripts/qa-agent.mjs')).href
    );
    const rows = [];
    for (const sample of samples) {
        const durations = [];
        let observation;
        for (let iteration = 0; iteration < 4; iteration++) {
            const ledger = {
                facts: [],
                searchHistory: [],
                citations: [],
                totalMatches: 0,
                dateRangeUsed: null,
                confidence: 'low',
            };
            const previews = [];
            let mockCalls = 0;
            const originalFetch = globalThis.fetch;
            globalThis.fetch = async (url, request) => {
                if (url !== 'https://retrieval-eval.invalid/chat/completions')
                    throw new Error('External requests forbidden');
                mockCalls++;
                const prompt = JSON.parse(request.body).messages[0].content;
                const lines = prompt.split('\n').filter((line) => /^\d+\. /.test(line));
                previews.push(...lines.map((line) => line.replace(/^\d+\. /, '')));
                return {
                    ok: true,
                    json: async () => ({
                        choices: [
                            {
                                message: {
                                    content: JSON.stringify(lines.map((_, index) => index)),
                                },
                            },
                        ],
                    }),
                };
            };
            let result;
            const started = performance.now();
            try {
                result = await executeTool(
                    'search_messages',
                    sample.args,
                    sample.messages,
                    ledger,
                    {
                        baseUrl: 'https://retrieval-eval.invalid',
                        apiKey: 'synthetic-not-a-key',
                        model: 'keep-all-stub',
                    },
                    sample.question,
                    { rerankBudget: { left: 4 } }
                );
            } finally {
                globalThis.fetch = originalFetch;
            }
            if (iteration) durations.push(performance.now() - started);
            const evidenceIds = [
                ...new Set(ledger.citations.map((citation) => String(citation.id))),
            ];
            const found = sample.gold.filter((id) => evidenceIds.includes(id)).length;
            const forbiddenFound = (sample.forbidden || []).filter((id) =>
                evidenceIds.includes(id)
            );
            const snippet = (result.snippets || []).join('\n');
            const state = {
                found,
                required: sample.gold.length,
                forbiddenFound,
                complete:
                    (sample.gold.length ? found === sample.gold.length : result.matchCount === 0) &&
                    forbiddenFound.length === 0,
                noEvidence: !sample.gold.length,
                evidenceIds,
                snippetChars: snippet.length,
                mockCalls,
                previewFound: (sample.previewNeedles || []).filter((term) =>
                    previews.some((text) => text.includes(term))
                ).length,
                previewRequired: sample.previewNeedles?.length || 0,
                maxPreviewChars: Math.max(0, ...previews.map((text) => text.length)),
            };
            if (observation && JSON.stringify(state) !== JSON.stringify(observation))
                throw new Error(`Nondeterministic ${arm}/${sample.id}`);
            observation = state;
        }
        durations.sort((left, right) => left - right);
        rows.push({
            id: sample.id,
            suite: sample.suite,
            category: sample.category,
            ...observation,
            medianMs: Number(durations[1].toFixed(3)),
        });
    }
    const suites = {};
    for (const suite of ['mechanism', 'validation']) {
        const subset = rows.filter((row) => row.suite === suite);
        const times = subset.map((row) => row.medianMs).sort((left, right) => left - right);
        suites[suite] = {
            passed: subset.filter((row) => row.complete).length,
            cases: subset.length,
            evidenceFound: subset.reduce((sum, row) => sum + row.found, 0),
            evidenceRequired: subset.reduce((sum, row) => sum + row.required, 0),
            noEvidencePassed: subset.filter((row) => row.noEvidence && row.complete).length,
            noEvidenceCases: subset.filter((row) => row.noEvidence).length,
            previewFound: subset.reduce((sum, row) => sum + row.previewFound, 0),
            previewRequired: subset.reduce((sum, row) => sum + row.previewRequired, 0),
            totalSnippetChars: subset.reduce((sum, row) => sum + row.snippetChars, 0),
            mockCalls: subset.reduce((sum, row) => sum + row.mockCalls, 0),
            p50Ms: times[Math.floor(times.length / 2)],
            p95Ms: times[Math.min(times.length - 1, Math.floor(times.length * 0.95))],
            failed: subset.filter((row) => !row.complete).map((row) => row.id),
        };
    }
    console.log(JSON.stringify({ arm, suites, rows }));
} else {
    const report = {
        datasetSha256: createHash('sha256').update(JSON.stringify(samples)).digest('hex'),
        controls:
            'One warmup + three repeated measurements per case per isolated process. Same corpus, questions, tool args, candidate/message limits and keep-all mock reranker. No answer model and no remote requests.',
        warning:
            'Artificial validation cases, not externally held-out data. Mock reranker checks input coverage, not semantic ranking quality. Multiple same-template variants are not independent tasks.',
        runs: [],
    };
    for (const variant of [...(baselineRoot ? ['baseline'] : []), ...arms]) {
        const args = [
            fileURLToPath(import.meta.url),
            '--arm',
            variant,
            ...(baselineRoot ? ['--baseline-root', baselineRoot] : []),
        ];
        const child = spawnSync(process.execPath, args, {
            encoding: 'utf8',
            maxBuffer: 16 * 1024 * 1024,
            env: { ...process.env, TZ: 'UTC' },
        });
        if (child.status !== 0) throw new Error(child.stderr || child.stdout);
        const run = JSON.parse(child.stdout);
        report.runs.push(run);
        console.log(JSON.stringify({ arm: run.arm, suites: run.suites }, null, 2));
    }
    const baseline = report.runs.find((run) => run.arm === 'baseline');
    const current = report.runs.find((run) => run.arm === 'current');
    if (baseline) {
        report.regressions = current.rows
            .filter((row, index) => baseline.rows[index].complete && !row.complete)
            .map((row) => row.id);
        console.log('REGRESSIONS', JSON.stringify(report.regressions));
    }
    if (option('--output'))
        fs.writeFileSync(option('--output'), JSON.stringify(report, null, 2) + '\n');
}
