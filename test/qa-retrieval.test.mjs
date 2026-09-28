import { test } from 'node:test';
import assert from 'node:assert/strict';
import { executeTool } from '../scripts/qa-agent.mjs';
import { retrievalCases } from './fixtures/qa-retrieval-cases.mjs';
import { retrievalValidationCases } from './fixtures/qa-retrieval-validation.mjs';

const makeLedger = () => ({
    facts: [],
    searchHistory: [],
    citations: [],
    totalMatches: 0,
    dateRangeUsed: null,
    confidence: 'low',
});
for (const sample of retrievalValidationCases().filter(
    (sample) => sample.category === 'no-evidence'
)) {
    test(`query expansion must not retrieve question boilerplate: ${sample.id}`, async () => {
        const ledger = makeLedger();
        const result = await executeTool(
            'search_messages',
            sample.args,
            sample.messages,
            ledger,
            null,
            sample.question
        );
        assert.equal(result.matchCount, 0);
        assert.deepEqual(ledger.citations, []);
    });
}
for (const sample of retrievalCases()) {
    test(`retrieval stress: ${sample.id}`, async () => {
        const ledger = makeLedger();
        const result = await executeTool(
            'search_messages',
            sample.args,
            sample.messages,
            ledger,
            null,
            sample.question
        );
        const evidence = new Set(ledger.citations.map((citation) => String(citation.id)));
        for (const required of sample.gold)
            assert.ok(evidence.has(required), `missing evidence ${required}`);
        if (!sample.gold.length) assert.equal(result.matchCount, 0);
        assert.ok((result.snippets || []).length <= 8);
        for (const trace of ledger.retrievalTrace || []) {
            assert.ok(trace.queries.length <= 4);
            assert.ok(trace.candidates.length <= (trace.unit === 'topic_chunk' ? 20 : 40));
            assert.ok(
                trace.evidenceIds.every((id) =>
                    sample.messages.some((message) => message.id === id)
                )
            );
            assert.ok(
                trace.selected.every((index) =>
                    trace.candidates.some((candidate) => candidate.idx === index)
                )
            );
        }
        if (sample.category === 'multiple-evidence') {
            assert.ok(evidence.size <= 17);
            assert.match(result.snippets.join('\n'), /中间消息已省略/);
        }
    });
}

test('explicit dates/person apply equally to every fused query and disable recency', async () => {
    const sample = retrievalCases()[0];
    const ledger = makeLedger();
    const result = await executeTool(
        'search_messages',
        { ...sample.args, person: '成员甲', dateFrom: '2026-01-01', dateTo: '2026-01-01' },
        sample.messages,
        ledger,
        null,
        `${sample.question} 最新`
    );
    assert.equal(result.totalInRange, 1);
    assert.deepEqual(ledger.retrievalTrace[0].evidenceIds, ['original-decision']);
    assert.equal(ledger.retrievalTrace[0].timePolicy, 'relevance');
});

test('reranker receives late hits in original messages, no more than 120 characters per candidate', async () => {
    const messages = Array.from({ length: 4 }, (_, block) =>
        Array.from({ length: 24 }, (_, index) => ({
            id: `${block}-${index}`,
            user: '测试成员',
            timestamp: Date.parse('2026-01-01T00:00:00Z') + (block * 180 + index) * 60000,
            time: `2026/01/01 ${String(block * 3).padStart(2, '0')}:${String(index).padStart(2, '0')}:00`,
            content: index === 20 ? `项目 KEY${block} 的命中内容` : `例行讨论 ${index}`,
        }))
    ).flat();
    const originalFetch = globalThis.fetch;
    let calls = 0;
    globalThis.fetch = async (_url, request) => {
        calls++;
        const prompt = JSON.parse(request.body).messages[0].content;
        const candidateLines = prompt.split('\n').filter((line) => /^\d+\. /.test(line));
        assert.equal(candidateLines.length, 4);
        for (const line of candidateLines) {
            assert.match(line, /KEY\d/);
            assert.ok(line.replace(/^\d+\. /, '').length <= 120);
        }
        return {
            ok: true,
            json: async () => ({ choices: [{ message: { content: '[0,1,2,3]' } }] }),
        };
    };
    try {
        const ledger = makeLedger();
        const result = await executeTool(
            'search_messages',
            { keywords: ['项目'] },
            messages,
            ledger,
            { baseUrl: 'https://example.invalid', model: 'mock', apiKey: 'synthetic' },
            '项目 KEY0 KEY1 KEY2 KEY3',
            { rerankBudget: { left: 1 } }
        );
        assert.equal(calls, 1);
        assert.equal(result.reranked, true);
        assert.ok(
            ledger.retrievalTrace[0].candidates.every((candidate) => candidate.ranks.length > 0)
        );
    } finally {
        globalThis.fetch = originalFetch;
    }
});

test('flat fallback uses hit-centered rerank input and obeys exhausted rerank budget', async () => {
    const messages = Array.from({ length: 6 }, (_, index) => ({
        id: `flat-${index}`,
        user: '测试成员',
        timestamp: 1000 + index,
        time: '2026/01/01 09:00:00',
        content: '寒暄'.repeat(140) + ` UNIQUE_ID_${index} 结论`,
    }));
    const originalFetch = globalThis.fetch;
    let calls = 0;
    globalThis.fetch = async (_url, request) => {
        calls++;
        const prompt = JSON.parse(request.body).messages[0].content;
        const lines = prompt.split('\n').filter((line) => /^\d+\. /.test(line));
        assert.ok(lines.every((line) => /UNIQUE_ID_/.test(line)));
        return {
            ok: true,
            json: async () => ({ choices: [{ message: { content: '[0,1,2,3,4,5]' } }] }),
        };
    };
    try {
        const args = { keywords: messages.map((_, index) => `UNIQUE_ID_${index}`) };
        const config = { baseUrl: 'https://example.invalid', model: 'mock', apiKey: 'synthetic' };
        const result = await executeTool(
            'search_messages',
            args,
            messages,
            makeLedger(),
            config,
            args.keywords.join(' ')
        );
        assert.equal(result.matchUnit, 'message');
        assert.equal(result.reranked, true);
        assert.equal(calls, 1);
        await executeTool(
            'search_messages',
            args,
            messages,
            makeLedger(),
            config,
            args.keywords.join(' '),
            { rerankBudget: { left: 0 } }
        );
        assert.equal(calls, 1);
    } finally {
        globalThis.fetch = originalFetch;
    }
});

test('reranker failures keep usable candidates and evidence', async () => {
    const sample = retrievalCases()[0];
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () => {
        throw new Error('synthetic rerank unavailable');
    };
    try {
        const ledger = makeLedger();
        const result = await executeTool(
            'search_messages',
            sample.args,
            sample.messages,
            ledger,
            { baseUrl: 'https://example.invalid', model: 'mock', apiKey: 'synthetic' },
            sample.question
        );
        assert.equal(result.reranked, false);
        assert.ok(ledger.citations.some((citation) => citation.id === 'original-decision'));
    } finally {
        globalThis.fetch = originalFetch;
    }
});
