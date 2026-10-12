import { test } from 'node:test';
import assert from 'node:assert/strict';
import { executeTool } from '../scripts/qa-agent.mjs';
import { retrievalValidationCases } from './fixtures/qa-retrieval-validation.mjs';
import { candidateCases } from './fixtures/qa-candidate-cases.mjs';
import policy from '../lib/retrieval-policy.js';

for (const sample of candidateCases()) {
    test(`candidate quality boundary: ${sample.id}`, async () => {
        const ledger = { facts: [], searchHistory: [], citations: [], totalMatches: 0 };
        const result = await executeTool(
            'search_messages',
            sample.args,
            sample.messages,
            ledger,
            null,
            sample.question
        );
        const ids = ledger.citations.map((citation) => citation.id);
        for (const id of sample.gold) assert.ok(ids.includes(id), `missing ${id}`);
        for (const id of sample.forbidden || []) assert.ok(!ids.includes(id), `unexpected ${id}`);
        for (const trace of ledger.retrievalTrace || []) {
            for (const candidate of trace.candidates) {
                if (candidate.messageIds.some((id) => sample.notExact?.includes(id)))
                    assert.deepEqual(candidate.exactMatches, []);
            }
        }
        assert.ok(result.snippets.length <= 8);
    });
}

test('exact clues require full identifiers and bounded explicit matching', () => {
    assert.deepEqual(policy.exactClues('Redis 缓存 部署'), []);
    assert.equal(policy.matchesExact('BUG-731', 'bug-73'), false);
    assert.equal(policy.matchesExact('postgres.org.evil', 'postgres.org'), false);
    assert.equal(policy.matchesExact('notpostgres.org', 'postgres.org'), false);
    assert.equal(policy.matchesExact('https://postgres.org/docs', 'postgres.org'), true);
    assert.equal(policy.matchesExact('https://a.org/docs/v2', 'https://a.org/docs'), false);
    assert.equal(policy.matchesExact('xrelease.md', 'release.md'), false);
    assert.ok(
        policy
            .exactClues('https://a.org/docs?x=1，BUG-731 release.md')
            .includes('https://a.org/docs?x=1')
    );
});

test('duplicate quota keeps source ids, distinct wording and newest repeated evidence', () => {
    const docs = ['same text', 'same text', 'same text', 'different', 'not same text'];
    const hits = docs.map((_, idx) => ({ idx, score: 5 - idx }));
    const selected = policy.selectCandidates(hits, docs, 4);
    assert.deepEqual(
        selected.map((hit) => hit.idx),
        [0, 1, 3, 4]
    );
    assert.ok(selected[0].duplicateIndexes.includes(2));
    const latest = policy.fusedSearch(docs, ['same'], 3, {
        documents: docs,
        preferRecent: true,
        timestampOf: (index) => index,
    });
    assert.ok(latest.some((hit) => hit.idx === 2));
});

test('exact slots are limited and only grounded in original text', () => {
    const hits = Array.from({ length: 6 }, (_, idx) => ({ idx, score: 6 - idx }));
    const docs = ['generic first', 'generic second', 'BUG-7', 'BUG-7 x', 'BUG-7 y', 'generic'];
    assert.deepEqual(
        policy.selectCandidates(hits, docs, 4, ['bug-7']).map((hit) => hit.idx),
        [2, 3, 0, 1]
    );
    const annotated = ['annotation BUG-7', 'original BUG-7'];
    const raw = ['unrelated source', 'original BUG-7'];
    const result = policy.fusedSearch(annotated, ['BUG-7'], 2, {
        documents: raw,
        clues: ['bug-7'],
    });
    assert.deepEqual(result.find((hit) => hit.idx === 0).exactMatches, []);
    assert.deepEqual(result.find((hit) => hit.idx === 1).exactMatches, ['bug-7']);
});

test('exact protection survives a candidate budget filled by broad matches', async () => {
    const messages = Array.from({ length: 48 }, (_, index) => ({
        id: `broad-${index}`,
        user: '甲',
        content: `数据库文档 事项${index}`,
        time: '2026/01/01 10:00:00',
        timestamp: 1000 + index * 3600000,
    }));
    messages.push({
        id: 'exact-target',
        user: '乙',
        content: '链接资料',
        share: { url: 'https://postgres.org/docs' },
        time: '2026/01/04 10:00:00',
        timestamp: 1000 + 49 * 3600000,
    });
    const ledger = { facts: [], searchHistory: [], citations: [], totalMatches: 0 };
    await executeTool(
        'search_messages',
        { keywords: ['数据库文档'] },
        messages,
        ledger,
        null,
        'postgres.org 的文档'
    );
    assert.ok(ledger.citations.some((citation) => citation.id === 'exact-target'));
    assert.ok(ledger.retrievalTrace[0].candidates.length <= 20);
    assert.ok(ledger.retrievalTrace[0].selected.length <= 8);
});

test('exact protection does not reintroduce a candidate rejected by reranking', async () => {
    const sample = candidateCases()[0];
    const originalFetch = globalThis.fetch;
    let calls = 0;
    globalThis.fetch = async () => {
        calls++;
        return {
            ok: true,
            json: async () => ({ choices: [{ message: { content: '[1,2,3,4]' } }] }),
        };
    };
    try {
        const ledger = { facts: [], searchHistory: [], citations: [], totalMatches: 0 };
        await executeTool(
            'search_messages',
            sample.args,
            sample.messages,
            ledger,
            { baseUrl: 'https://example.invalid', apiKey: 'mock', model: 'mock' },
            sample.question
        );
        assert.equal(calls, 1);
        assert.ok(!ledger.citations.some((citation) => citation.id === 'exact'));
    } finally {
        globalThis.fetch = originalFetch;
    }
});

for (const id of ['decision-rollback', 'url-original']) {
    test(`candidate quality must retain evidence: ${id}`, async () => {
        const sample = retrievalValidationCases().find((item) => item.id === id);
        const ledger = { facts: [], searchHistory: [], citations: [], totalMatches: 0 };
        const result = await executeTool(
            'search_messages',
            sample.args,
            sample.messages,
            ledger,
            null,
            sample.question
        );
        assert.ok(
            ledger.citations.some((citation) => citation.id === sample.gold[0]),
            `missing ${sample.gold[0]}`
        );
        assert.ok(result.snippets.length <= 8);
    });
}
