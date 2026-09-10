const { test } = require('node:test');
const assert = require('node:assert');
const { normalizeMessage } = require('../lib/normalize-message.js');

// tsEstimated 是归档状态推进的守门员：兜底时间戳（Date.now()）绝不能参与
// lastTimestamp 计算，否则分页起点与捕获时刻之间的消息会被永久跳过。

test('有 time 的消息：真实时间戳，不带 tsEstimated', () => {
    const r = normalizeMessage({ id: 1, time: 1700000000, content: 'x' });
    assert.strictEqual(r.timestamp, 1700000000000);
    assert.ok(!('tsEstimated' in r));
});

test('created_at 可解析时视作真实时间戳', () => {
    const r = normalizeMessage({ id: 1, created_at: 'Wed Nov 15 12:00:00 +0800 2023' });
    assert.strictEqual(r.timestamp, Date.parse('Wed Nov 15 12:00:00 +0800 2023'));
    assert.ok(!('tsEstimated' in r));
});

test('无任何时间信息：兜底 Date.now() 且打 tsEstimated', () => {
    const before = Date.now();
    const r = normalizeMessage({ id: 1, content: 'x' });
    assert.ok(r.timestamp >= before && r.timestamp <= Date.now());
    assert.strictEqual(r.tsEstimated, true);
    // 日期文件名不能是 NaN-NaN-NaN
    assert.match(r.date, /^\d{4}-\d{2}-\d{2}$/);
});

test('created_at 解析出 NaN 同样兜底 + tsEstimated（不得产出 NaN 日期）', () => {
    const r = normalizeMessage({ id: 1, created_at: 'not a date', content: 'x' });
    assert.ok(Number.isFinite(r.timestamp));
    assert.strictEqual(r.tsEstimated, true);
    assert.match(r.date, /^\d{4}-\d{2}-\d{2}$/);
});

test('无 id 返回 null', () => {
    assert.strictEqual(normalizeMessage({ content: 'x' }), null);
});
