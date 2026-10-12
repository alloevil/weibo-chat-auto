const { test } = require('node:test');
const assert = require('node:assert/strict');
const { searchMessages, listSearchMembers } = require('../lib/search-messages');

const messages = [
    {
        id: 'first',
        date: '2026-09-20',
        from_uid: '1',
        user: '同名',
        content: '部署稍后准备回滚',
        timestamp: 1,
    },
    {
        id: 'last',
        date: '2026-09-22',
        from_uid: 1,
        user: '改名',
        content: '回滚前核对部署',
        timestamp: 2,
    },
    {
        id: 'other',
        date: '2026-09-21',
        from_uid: '2',
        user: '同名',
        content: '部署 回滚',
        timestamp: 3,
    },
    { id: 'unknown', date: '2026-09-21', user: '同名', content: '部署 回滚', timestamp: 4 },
    {
        id: 'early',
        date: '2026-09-19',
        from_uid: '1',
        user: '同名',
        content: '部署 回滚',
        timestamp: 5,
    },
    {
        id: 'late',
        date: '2026-09-23',
        from_uid: '1',
        user: '同名',
        content: '部署 回滚',
        timestamp: 6,
    },
    {
        id: 'name-only',
        date: '2026-09-21',
        from_uid: '1',
        user: '回滚',
        content: '部署',
        timestamp: 7,
    },
];
const conditions = {
    mode: 'combined',
    fromUid: '1',
    dateFrom: '2026-09-20',
    dateTo: '2026-09-22',
    keywords: '部署 回滚',
};
const ids = (result) => result.hits.map((hit) => hit.id);

test('组合检索：重复归档按日期和消息ID去重后再计数分页，旧q仍保持原语义', () => {
    const duplicate = [messages[0], { ...messages[0] }, messages[1]];
    const first = searchMessages(duplicate, '', { ...conditions, limit: 1 });
    const second = searchMessages(duplicate, '', { ...conditions, limit: 1, offset: 1 });
    assert.equal(first.total, 2);
    assert.equal(second.total, 2);
    assert.deepEqual(first.byDate, [
        { date: '2026-09-22', count: 1 },
        { date: '2026-09-20', count: 1 },
    ]);
    assert.equal(second.truncated, false);
    assert.deepEqual([...ids(first), ...ids(second)], ['last', 'first']);
    assert.equal(searchMessages(duplicate, '部署').total, 3);
});

test('组合检索：稳定ID不合并同名，归档日期含首尾而非timestamp范围，正文非相邻反序AND', () => {
    const result = searchMessages(messages, '不参与组合的旧q', conditions);
    assert.deepEqual(ids(result), ['last', 'first']);
    assert.deepEqual(result.byDate, [
        { date: '2026-09-22', count: 1 },
        { date: '2026-09-20', count: 1 },
    ]);
    assert.deepEqual(
        ids(searchMessages(messages, '', { ...conditions, keywords: '回滚\t部署 部署' })),
        ['last', 'first']
    );
});

test('组合检索：正文大小写不敏感但不跨昵称匹配', () => {
    assert.equal(
        searchMessages([{ content: 'ROLLBACK then DEPLOY' }], '', {
            mode: 'combined',
            keywords: 'deploy rollback',
        }).total,
        1
    );
    assert.equal(
        searchMessages([{ user: '回滚', content: '部署' }], '', {
            mode: 'combined',
            keywords: '部署 回滚',
        }).total,
        0
    );
});

test('组合检索：空条件不扫描语料，旧q不能隐式扩展组合查询', () => {
    const unscannable = {
        [Symbol.iterator]() {
            throw new Error('must not scan');
        },
    };
    for (const keywords of ['', '  \t\n'])
        assert.equal(searchMessages(unscannable, '部署', { mode: 'combined', keywords }).total, 0);
});

test('组合检索：日期非法、伪日期和逆序拒绝，单边范围与闰年合法', () => {
    for (const dateFrom of ['2026-02-29', '2026-09-31', '2026-13-01', '2026-9-01', '../2026-09-01'])
        assert.throws(
            () => searchMessages(messages, '', { mode: 'combined', dateFrom }),
            RangeError
        );
    assert.throws(
        () => searchMessages(messages, '', { ...conditions, dateFrom: '2026-09-23' }),
        /不能晚于/
    );
    assert.doesNotThrow(() => searchMessages([], '', { mode: 'combined', dateFrom: '2024-02-29' }));
    assert.deepEqual(
        ids(searchMessages(messages, '', { mode: 'combined', dateFrom: '2026-09-23' })),
        ['late']
    );
    assert.deepEqual(
        ids(searchMessages(messages, '', { mode: 'combined', dateTo: '2026-09-19' })),
        ['early']
    );
});

test('组合检索：单项条件、逐项移除、未知成员与空结果', () => {
    assert.equal(searchMessages(messages, '', { mode: 'combined', fromUid: '1' }).total, 5);
    assert.equal(searchMessages(messages, '', { ...conditions, fromUid: '' }).total, 4);
    assert.equal(searchMessages(messages, '', { ...conditions, dateFrom: '' }).total, 3);
    assert.equal(searchMessages(messages, '', { ...conditions, dateTo: '' }).total, 3);
    assert.equal(searchMessages(messages, '', { ...conditions, keywords: '部署' }).total, 3);
    assert.equal(searchMessages(messages, '', { ...conditions, fromUid: 'missing' }).total, 0);
});

test('组合检索：过滤全语料后统计与分页，后60条之外的命中保留且跨页不重不漏', () => {
    const corpus = Array.from({ length: 141 }, (_, index) => ({
        id: String(index),
        date: index < 70 ? '2026-09-20' : '2026-09-22',
        from_uid: '1',
        content: `${'前'.repeat(120)}回滚${'中'.repeat(120)}部署`,
        timestamp: index,
    }));
    corpus.push(
        ...Array.from({ length: 100 }, (_, index) => ({
            id: `noise-${index}`,
            date: '2026-09-23',
            from_uid: '2',
            content: '部署 回滚',
            timestamp: 1000 + index,
        }))
    );
    const pages = [0, 60, 120, 180].map((offset) =>
        searchMessages(corpus, '', { ...conditions, offset, limit: 60 })
    );
    assert.deepEqual(
        pages.map((page) => page.hits.length),
        [60, 60, 21, 0]
    );
    assert.deepEqual(
        pages.map((page) => page.truncated),
        [true, true, false, false]
    );
    for (const page of pages) {
        assert.equal(page.total, 141);
        assert.deepEqual(page.byDate, [
            { date: '2026-09-22', count: 71 },
            { date: '2026-09-20', count: 70 },
        ]);
    }
    const allIds = pages.flatMap(ids);
    assert.equal(new Set(allIds).size, 141);
});

test('旧q兼容：未显式组合仍整串匹配正文或昵称，忽略新条件', () => {
    const original = searchMessages(messages, '部署 回滚');
    assert.deepEqual(
        searchMessages(messages, '部署 回滚', { ...conditions, mode: undefined }),
        original
    );
    assert.deepEqual(
        searchMessages(messages, '同名', { ...conditions, mode: 'unknown' }),
        searchMessages(messages, '同名')
    );
    assert.deepEqual(ids(original), ['late', 'early', 'unknown', 'other']);
});

test('全历史成员候选：同ID改名合并，同名不同ID分开，无ID不推断身份', () => {
    const result = listSearchMembers(messages);
    assert.equal(result.members.length, 2);
    assert.equal(result.unidentifiedMessages, 1);
    assert.equal(result.members.find((member) => member.id === '1').count, 5);
    assert.deepEqual(result.members.find((member) => member.id === '1').names, [
        '同名',
        '改名',
        '回滚',
    ]);
    assert.equal(result.members.find((member) => member.id === '2').count, 1);
});
