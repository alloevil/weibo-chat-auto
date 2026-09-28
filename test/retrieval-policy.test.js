'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
    questionQuery,
    retrievalQueries,
    fusedSearch,
    recentQuery,
    rankByTime,
    hitExcerpt,
    evidenceIndexes,
    rerankExcerpt,
} = require('../lib/retrieval-policy');

test('question cleanup removes request boilerplate without dropping identifiers or negation', () => {
    assert.equal(questionQuery('请问群里有没有讨论过火星样本运输？'), '火星样本运输？');
    assert.equal(
        questionQuery('Does anyone know about quantum teleportation?'),
        'quantum teleportation?'
    );
    assert.match(
        questionQuery('Why was BUG-731 not fixed in 2026-02?'),
        /BUG-731 not fixed.*2026-02/
    );
    assert.match(questionQuery('谁分享过 postgres.org 的文档？'), /postgres.org/);
});

test('retrieval queries retain original question, deduplicate tokens and cap variants', () => {
    assert.deepEqual(
        retrievalQueries('deploy release', 'release deploy', ['deploy', 'release', 'ignored']),
        ['deploy release', 'deploy', 'release']
    );
    assert.equal(retrievalQueries('term', 'original', ['first', 'second', 'third']).length, 4);
    assert.deepEqual(retrievalQueries('', '', []), []);
    assert.ok(retrievalQueries('x'.repeat(800), '')[0].length <= 512);
});

test('RRF combines ranks rather than raw scores and is deterministic', () => {
    const hits = fusedSearch(['alpha', 'beta', 'alpha beta'], ['alpha', 'beta'], 3);
    assert.equal(hits[0].idx, 2);
    assert.equal(hits[0].ranks.length, 2);
    assert.ok(Math.abs(hits[0].score - 2 / 62) < 1e-12);
    assert.deepEqual(hits, fusedSearch(['alpha', 'beta', 'alpha beta'], ['alpha', 'beta'], 3));
    assert.equal(fusedSearch(['alpha', 'beta'], ['alpha', 'beta'], 1).length, 1);
});

test('time policy enables only clear recency, explicit/historical dates win', () => {
    for (const question of ['最新方案', '近期发布', 'latest release'])
        assert.equal(recentQuery(question), true);
    for (const question of [
        '方案怎么决定的',
        '去年最新方案',
        '最早的记录',
        'latest release in 2025-03',
        '上周最新讨论',
    ])
        assert.equal(recentQuery(question), false);
    assert.equal(recentQuery('最新方案', { dateFrom: '2025-01-01' }), false);
    assert.equal(recentQuery('近期发布', { dateTo: '2025-01-01' }), false);
});

test('non-recent ranking preserves relevance, recent ranking reports its weight', () => {
    const hits = [
        { idx: 0, score: 0.03 },
        { idx: 1, score: 0.02 },
    ];
    const timestamps = [1000, 1000 + 7 * 86400000];
    const old = rankByTime(hits, (index) => timestamps[index], false);
    const recent = rankByTime(hits, (index) => timestamps[index], true);
    assert.equal(old[0].idx, 0);
    assert.equal(recent[0].idx, 1);
    assert.ok(Math.abs(recent[1].timeWeight - 0.5 ** 3.5) < 1e-12);
    assert.equal(rankByTime(hits, () => undefined, true)[0].timeWeight, 1);
});

test('hit excerpt shows late identifiers instead of unrelated leading text', () => {
    const excerpt = hitExcerpt(
        '寒暄'.repeat(120) + ' PROTOCOL_X29 最终需要开启校验 ' + '尾部'.repeat(120),
        'PROTOCOL_X29'
    );
    assert.match(excerpt, /PROTOCOL_X29/);
    assert.ok(excerpt.length <= 120);
});

test('bounded evidence windows cover separated hits in chronological order', () => {
    const selected = evidenceIndexes(48, [8, 38, 8], 17);
    assert.equal(selected.length, 17);
    assert.ok(selected.includes(8) && selected.includes(38));
    assert.deepEqual(
        selected,
        [...selected].sort((left, right) => left - right)
    );
    assert.equal(new Set(selected).size, 17);
    assert.deepEqual(evidenceIndexes(3, [-1, 3]), []);
    assert.deepEqual(evidenceIndexes(3, [0], 17), [0, 1, 2]);
});

test('rerank preview contains real hit text and stays within the existing 120-character limit', () => {
    const messages = ['start', 'context', 'FIRST_ID proof', 'neighbor', 'LAST_ID proof'];
    const excerpt = rerankExcerpt(messages, [2, 4], 'FIRST_ID LAST_ID', (message) => message);
    assert.match(excerpt, /FIRST_ID/);
    assert.match(excerpt, /LAST_ID/);
    assert.ok(excerpt.length <= 120);
});
