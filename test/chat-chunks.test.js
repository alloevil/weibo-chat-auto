const { test } = require('node:test');
const assert = require('node:assert');
const { splitIntoChunks, chunkKey } = require('../lib/chat-chunks.js');

const MIN = 60000;
function mk(id, offsetMin, user = 'u') {
    return { id, user, timestamp: 1750000000000 + offsetMin * MIN, time: '2026/07/01 10:00:00' };
}

test('splitIntoChunks: 按 30 分钟断层切分', () => {
    const msgs = [mk(1, 0), mk(2, 5), mk(3, 10), mk(4, 50), mk(5, 55)];
    const chunks = splitIntoChunks(msgs);
    assert.strictEqual(chunks.length, 2);
    assert.deepStrictEqual(chunks[0].msgIds, [1, 2, 3]);
    assert.deepStrictEqual(chunks[1].msgIds, [4, 5]);
    assert.strictEqual(chunks[0].seq, 0);
    assert.strictEqual(chunks[1].seq, 1);
});

test('splitIntoChunks: 长块在内部最大间隔处递归二分', () => {
    // 12 条连续消息,第 6-7 条之间有 20 分钟间隔(不足 30 分钟断层但是最大间隔)
    const msgs = [];
    for (let i = 0; i < 6; i++) msgs.push(mk(i + 1, i * 2));
    for (let i = 0; i < 6; i++) msgs.push(mk(i + 7, 30 + i * 2)); // 10→30 间隔20分钟
    const chunks = splitIntoChunks(msgs, { maxMsgs: 8 });
    assert.strictEqual(chunks.length, 2);
    assert.deepStrictEqual(chunks[0].msgIds, [1, 2, 3, 4, 5, 6]);
    assert.deepStrictEqual(chunks[1].msgIds, [7, 8, 9, 10, 11, 12]);
    assert.ok(chunks.every(c => c.msgIds.length <= 8));
});

test('splitIntoChunks: 确定性(同输入同输出)+ 元数据正确', () => {
    const msgs = [mk(1, 0, 'alice'), mk(2, 5, 8225980033), mk(3, 10, 'alice')];
    const a = splitIntoChunks(msgs);
    const b = splitIntoChunks(msgs);
    assert.deepStrictEqual(a, b);
    assert.deepStrictEqual(a[0].users, ['alice', '8225980033']); // 数字 user 转字符串
    assert.strictEqual(a[0].startTs, msgs[0].timestamp);
    assert.strictEqual(a[0].endTs, msgs[2].timestamp);
    assert.strictEqual(a[0].date, '2026-07-01');
});

test('splitIntoChunks: 空输入与单条消息', () => {
    assert.deepStrictEqual(splitIntoChunks([]), []);
    const one = splitIntoChunks([mk(1, 0)]);
    assert.strictEqual(one.length, 1);
    assert.deepStrictEqual(one[0].msgIds, [1]);
});

test('splitIntoChunks: 全部消息都被分配,无遗漏无重复', () => {
    const msgs = [];
    for (let i = 0; i < 137; i++) msgs.push(mk(i + 1, i * 3 + (i % 17 === 0 ? 40 : 0)));
    msgs.sort((a, b) => a.timestamp - b.timestamp);
    const chunks = splitIntoChunks(msgs, { maxMsgs: 20 });
    const ids = chunks.flatMap(c => c.msgIds);
    assert.strictEqual(ids.length, 137);
    assert.strictEqual(new Set(ids).size, 137);
    assert.ok(chunks.every(c => c.msgIds.length <= 20));
});

test('chunkKey: 由 msgIds 决定,稳定且可区分', () => {
    const msgs = [mk(1, 0), mk(2, 5)];
    const [c] = splitIntoChunks(msgs);
    assert.strictEqual(chunkKey(c), chunkKey({ msgIds: [1, 2] }));
    assert.notStrictEqual(chunkKey({ msgIds: [1, 2] }), chunkKey({ msgIds: [1, 3] }));
    assert.match(chunkKey(c), /^[0-9a-f]{12}$/);
});
