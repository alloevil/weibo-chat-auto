const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { escapeHtml, escapeAttr } = require('../lib/text-utils');
const html = fs.readFileSync(path.join(__dirname, '../viewer.html'), 'utf8');
const calls = [];
const api = vm.createContext({
    captureContextReturn: () => {},
    escapeHtml,
    escapeAttr,
    currentGroup: 'g',
    archiveRevision: 1,
    jumpToSource: (...args) => calls.push(args),
});
vm.runInContext(
    html.slice(
        html.indexOf('function contextQuoteText('),
        html.indexOf('function renderContext(session,')
    ),
    api
);
const separator = ' - - - - - - - - - - - - - - - ';
const original = {
    id: 'original',
    date: '2026-09-20',
    content: '共同'.repeat(20) + '正确',
    user: '原作者',
    from_uid: 'one',
    timestamp: 1,
};
const quote = (id, text = original.content, extras = {}) => ({
    id,
    date: '2026-09-21',
    content: `「${text}」${separator}回复`,
    timestamp: 2,
    user: '引用人',
    from_uid: 'two',
    ...extras,
});
const session = (rows) => ({
    group: 'g',
    archive: 1,
    date: original.date,
    plan: { previous: '2026-09-19', next: '2026-09-21' },
    cache: new Map(
        ['2026-09-19', '2026-09-20', '2026-09-21'].map((date) => [
            date,
            rows.filter((message) => message.date === date),
        ])
    ),
    pending: new Set(),
    failed: new Set(),
});
const ids = (result) => Array.from(result.clues, (clue) => clue.message.id);

test('反向线索跨日规范化全文，排除30字前缀相同的不同尾文', () => {
    const current = session([
        original,
        quote('yes'),
        quote('no', original.content.replace('正确', '错误')),
    ]);
    assert.deepEqual(ids(api.loadedReverseReferences(original, current)), ['yes']);
    assert.equal(api.loadedReverseReferences(original, current).clues[0].reference.kind, 'text');
});

test('嵌套引用完整解析，前后向候选对称且不删除空格制造匹配', () => {
    const focus = { ...original, content: '他说「保留「旧版本」」再执行' };
    const reply = quote('nested', focus.content);
    const current = session([focus, reply]);
    const result = api.loadedReverseReferences(focus, current);
    assert.deepEqual(ids(result), ['nested']);
    assert.equal(result.clues[0].reference.quote, focus.content);
    assert.equal(api.loadedReferenceCandidates(reply, current).candidates[0].id, focus.id);
    assert.deepEqual(
        ids(
            api.loadedReverseReferences(
                { ...focus, content: '部署 回滚' },
                session([{ ...focus, content: '部署 回滚' }, quote('no', '部署回滚')])
            )
        ),
        []
    );
});

test('同文多个原文对每个原文均仅有歧义文本线索，不选首条', () => {
    const duplicate = { ...original, id: 'duplicate', from_uid: 'three' };
    const current = session([original, duplicate, quote('reply')]);
    for (const focus of [original, duplicate]) {
        const result = api.loadedReverseReferences(focus, current);
        assert.deepEqual(ids(result), ['reply']);
        assert.equal(result.clues[0].reference.candidates.length, 2);
        assert.equal(result.clues[0].reference.verified, undefined);
        assert.match(api.renderReverseReferences(focus, current), /歧义/);
    }
});

test('显式日期/ID/稳定身份/群冲突不退回全文候选，合法ID无需相同引用文字', () => {
    const reference = {
        id: original.id,
        date: original.date,
        from_uid: original.from_uid,
        group: 'g',
    };
    const correct = quote('valid', '不相同文字', { reply_to: reference });
    const conflicts = ['id', 'date', 'from_uid', 'group'].map((field) =>
        quote(field, original.content, { reply_to: { ...reference, [field]: 'wrong' } })
    );
    const current = session([original, correct, ...conflicts]);
    const result = api.loadedReverseReferences(original, current);
    assert.deepEqual(ids(result), ['valid']);
    assert.equal(result.clues[0].reference.verified, true);
});

test('仅W11已加载当前/邻日，旧缓存更远日期不入，重复归档去重', () => {
    const current = session([original, quote('reply'), quote('reply')]);
    current.cache.set('2026-09-18', [quote('outside', original.content, { date: '2026-09-18' })]);
    assert.deepEqual(ids(api.loadedReverseReferences(original, current)), ['reply']);
    current.cache.delete('2026-09-21');
    current.failed.add('2026-09-21');
    const result = api.loadedReverseReferences(original, current);
    assert.equal(result.incomplete, true);
    assert.equal(result.clues.length, 0);
});

test('缓存反向跳转仅明确调用时发生，校验群与revision，保留安全转义', () => {
    const current = session([
        original,
        quote('<reply>', '<img>', {
            reply_to: { id: original.id, date: original.date },
            user: '<名字>',
        }),
    ]);
    api.ctxSession = current;
    calls.length = 0;
    const rendered = api.renderReverseReferences(original, current);
    assert.ok(rendered.includes('&lt;img&gt;'));
    assert.ok(!rendered.includes('<img>'));
    const longQuote = '反向线索完整长原文。'.repeat(40);
    const longSession = session([
        original,
        quote('long', longQuote, { reply_to: { id: original.id, date: original.date } }),
    ]);
    const longRendered = api.renderReverseReferences(original, longSession);
    assert.match(longRendered, /<details open>/);
    assert.ok(longRendered.includes(longQuote));
    assert.equal(calls.length, 0);
    api.jumpReverseReference(0);
    assert.equal(calls.length, 1);
    assert.equal(calls[0][0], '2026-09-21');
    assert.equal(calls[0][1], '<reply>');
    assert.equal(calls[0][4], current.cache.get('2026-09-21'));
    api.currentGroup = 'other';
    api.jumpReverseReference(0);
    assert.equal(calls.length, 1);
    api.currentGroup = 'g';
    api.archiveRevision = 2;
    api.jumpReverseReference(0);
    assert.equal(calls.length, 1);
    api.archiveRevision = 1;
});
