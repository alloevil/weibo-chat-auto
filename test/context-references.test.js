const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const html = fs.readFileSync(path.join(__dirname, '../viewer.html'), 'utf8');
const context = vm.createContext({});
vm.runInContext(
    html.slice(
        html.indexOf('function contextQuoteText('),
        html.indexOf('function renderContextReference(')
    ),
    context
);
const separator = ' - - - - - - - - - - - - - - - ';
const focus = { id: 'reply', date: '2026-09-21', content: `「部署 回滚」${separator}收到` };
const source = {
    id: 'source',
    date: '2026-09-20',
    content: '部署 回滚',
    user: '原作者',
    from_uid: 'one',
};
const same = { ...source, id: 'same', date: '2026-09-21', from_uid: 'two' };
const session = (rows = [source, focus]) => ({
    group: 'g',
    date: focus.date,
    plan: { previous: '2026-09-20', next: '2026-09-22' },
    cache: new Map(
        ['2026-09-20', '2026-09-21'].map((date) => [date, rows.filter((row) => row.date === date)])
    ),
    pending: new Set(),
    failed: new Set(),
});
const result = (message = focus, current = session()) =>
    context.loadedReferenceCandidates(message, current);

test('引用解析保留完整嵌套文字与所有日期身份线索，不以30字符前缀猜来源', () => {
    assert.equal(context.contextQuoteText(`「他说「好」的」${separator}收到`), '他说「好」的');
    assert.equal(context.contextQuoteText('普通正文'), null);
    assert.equal(context.contextQuoteText(`引用文字${separator}正文`), '引用文字');
    const prefix = '相同'.repeat(20);
    assert.equal(
        result(
            { ...focus, content: `「${prefix}甲」${separator}收到` },
            session([{ ...source, content: prefix + '乙' }, focus])
        ).candidates.length,
        0
    );
});

test('跨日全文匹配唯一仍为文本候选；同文多源全部保留', () => {
    const unique = result();
    assert.equal(unique.kind, 'text');
    assert.equal(unique.verified, undefined);
    assert.equal(unique.candidates[0].id, 'source');
    const many = result(focus, session([source, { ...source }, same, focus]));
    assert.deepEqual(Array.from(many.candidates, (row) => row.id).sort(), ['same', 'source']);
});

test('只扫描本次本日及邻日已加载内容，旧会话缓存更早记录不能扩范围', () => {
    const current = session([focus]);
    current.cache.set('2026-09-18', [{ ...source, date: '2026-09-18' }]);
    assert.equal(result(focus, current).candidates.length, 0);
    current.failed.add('2026-09-20');
    assert.equal(result(focus, current).incomplete, true);
    current.cache.set('2026-09-20', [source]);
    assert.equal(result(focus, current).candidates.length, 1);
});

test('显式reply_to核对真实日期/ID、UID、群；错误标识不回落文字首条', () => {
    const reference = {
        id: 'source',
        date: '2026-09-20',
        from_uid: 'one',
        group: 'g',
        user: '原作者',
    };
    assert.equal(result({ ...focus, reply_to: reference }).verified, true);
    for (const patch of [
        { date: '2026-09-19' },
        { id: 'missing' },
        { from_uid: 'other' },
        { group: 'foreign' },
    ])
        assert.equal(
            result({ ...focus, reply_to: { ...reference, ...patch } }).candidates.length,
            0
        );
    const noDate = result({ ...focus, reply_to: { id: 'source' } });
    assert.equal(noDate.candidates.length, 1);
    assert.equal(noDate.verified, false);
});

test('显式无日期同ID跨日显示多候选，空引用不匹配所有消息', () => {
    const current = session([source, { ...source, date: '2026-09-21' }, focus]);
    const matched = result({ ...focus, reply_to: { id: 'source' } }, current);
    assert.equal(matched.candidates.length, 2);
    assert.equal(matched.verified, false);
    assert.equal(result({ ...focus, content: `「 」${separator}收到` }).candidates.length, 0);
});

test('文字仅规范化空白，不删除所有空格制造相同内容', () => {
    assert.equal(
        result({ ...focus, content: `「部署\n  回滚」${separator}收到` }).candidates.length,
        1
    );
    assert.equal(
        result({ ...focus, content: `「部署回滚」${separator}收到` }).candidates.length,
        0
    );
});

test('引用展示转义原文/元数据，已加载跳转不访问网络且校验会话', () => {
    const { escapeHtml, escapeAttr } = require('../lib/text-utils');
    const jumps = [];
    const current = session([
        { ...source, content: '<img src=x onerror=alert(1)>', user: '<昵称>' },
        focus,
    ]);
    current.archive = 7;
    const render = vm.createContext({
        captureContextReturn: () => {},
        escapeHtml,
        escapeAttr,
        currentGroup: 'g',
        archiveRevision: 7,
        ctxSession: current,
        jumpToSource: (...args) => jumps.push(args),
    });
    vm.runInContext(
        html.slice(
            html.indexOf('function contextQuoteText('),
            html.indexOf('function renderContext(session,')
        ),
        render
    );
    const quoted = { ...focus, content: `「<img src=x onerror=alert(1)>」${separator}收到` };
    const output = render.renderContextReference(quoted, current);
    assert.ok(output.includes('&lt;img'));
    assert.ok(!output.includes('<img'));
    assert.match(output, /不确认来源/);
    render.jumpReferenceCandidate(0);
    assert.equal(jumps.length, 1);
    assert.equal(jumps[0][0], '2026-09-20');
    assert.equal(jumps[0][1], 'source');
    assert.equal(jumps[0][4], current.cache.get('2026-09-20'));
    render.currentGroup = 'other';
    render.jumpReferenceCandidate(0);
    assert.equal(jumps.length, 1);
    render.currentGroup = 'g';
    render.archiveRevision = 8;
    render.jumpReferenceCandidate(0);
    assert.equal(jumps.length, 1);
});
