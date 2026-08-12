const { test } = require('node:test');
const assert = require('node:assert');
const { searchMessages, preview } = require('../lib/search-messages.js');

// 此前搜索只搜"当前选中的那一天"，16 万条历史里只扫了几百条。
// 这组测试锁住全量搜索的语义：子串命中、时间倒序、按天汇总、分页。

const msg = (id, date, hhmm, user, content) => ({
    id, date, time: `${date.replace(/-/g, '/')} ${hhmm}:00`,
    timestamp: Date.parse(`${date}T${hhmm}:00`), user, content,
});

const corpus = [
    msg(1, '2026-05-01', '10:00', '张三', '半导体还没跌到位'),
    msg(2, '2026-05-01', '11:00', '李四', '我也这么认为'),
    msg(3, '2026-06-15', '09:30', '王五', '再聊聊半导体的库存周期'),
    msg(4, '2026-08-10', '20:00', '半导体老哥', '大家好'),
    msg(5, '2026-08-10', '21:00', '张三', 'HALF conductor 混合大小写 SEMI'),
];

test('searchMessages: 跨全部日期命中，不再局限于某一天', () => {
    const r = searchMessages(corpus, '半导体');
    assert.strictEqual(r.total, 3, '正文两条 + 发送者名一条');
    assert.deepStrictEqual(r.hits.map(h => h.id), ['4', '3', '1'], '按时间倒序');
    assert.deepStrictEqual(r.byDate, [
        { date: '2026-08-10', count: 1 },
        { date: '2026-06-15', count: 1 },
        { date: '2026-05-01', count: 1 },
    ], '按天汇总用于快速定位，日期倒序');
});

test('searchMessages: 同时匹配发送者名', () => {
    const r = searchMessages(corpus, '半导体老哥');
    assert.deepStrictEqual(r.hits.map(h => h.user), ['半导体老哥']);
});

test('searchMessages: 大小写不敏感', () => {
    assert.strictEqual(searchMessages(corpus, 'semi').total, 1);
    assert.strictEqual(searchMessages(corpus, 'HALF').total, 1);
});

test('searchMessages: 空查询返回空结果而不是全部', () => {
    for (const q of ['', '   ', null, undefined]) {
        const r = searchMessages(corpus, q);
        assert.deepStrictEqual([r.total, r.hits.length], [0, 0], `查询 ${JSON.stringify(q)} 不该返回全部`);
    }
});

test('searchMessages: 分页与 truncated 标记', () => {
    const many = Array.from({ length: 25 }, (_, i) => msg(100 + i, '2026-07-01', String(10 + (i % 12)).padStart(2, '0'), 'u', '关键词 ' + i));
    const first = searchMessages(many, '关键词', { limit: 10 });
    assert.strictEqual(first.total, 25);
    assert.strictEqual(first.hits.length, 10);
    assert.strictEqual(first.truncated, true);

    const last = searchMessages(many, '关键词', { limit: 10, offset: 20 });
    assert.strictEqual(last.hits.length, 5);
    assert.strictEqual(last.truncated, false, '取到末页时不该再标 truncated');
});

test('searchMessages: 无命中时结构完整（前端不必判空）', () => {
    const r = searchMessages(corpus, '不存在的词');
    assert.deepStrictEqual(r, { total: 0, byDate: [], hits: [], truncated: false });
});

test('preview: 长消息以命中处为中心截断', () => {
    const long = '前' .repeat(120) + '关键词' + '后'.repeat(120);
    const p = preview(long, '关键词', 40);
    assert.ok(p.includes('关键词'), '命中词必须在摘要里');
    assert.ok(p.length <= 44, `摘要不该超长，实际 ${p.length}`);
    assert.ok(p.startsWith('…') && p.endsWith('…'), '两端应有省略标记');
});

test('preview: 短消息原样返回、空白归一', () => {
    assert.strictEqual(preview('  短消息   有空白 ', '短'), '短消息 有空白');
});

test('searchMessages: 缺字段的脏数据不抛错', () => {
    const dirty = [{ id: 9 }, { id: 10, content: null, user: undefined }, msg(11, '2026-01-01', '00:00', 'u', 'ok')];
    assert.strictEqual(searchMessages(dirty, 'ok').total, 1);
});
