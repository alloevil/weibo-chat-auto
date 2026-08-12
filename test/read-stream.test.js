const { test } = require('node:test');
const assert = require('node:assert');
const { Readable } = require('stream');
const { readUtf8 } = require('../lib/read-stream.js');

// 这组测试锁住一次真实的数据损坏：归档器用 `text += chunk` 逐块转字符串，
// 中文字（3 字节）跨 chunk 边界时两半各自解码失败 → ���。
// 实测已有 446 条归档消息被写坏（"这样咱就不用撤回了" → "���样咱就不用撤回了"）。

/** 把字符串按字节切成若干块（可故意切在多字节字符中间）。 */
function streamOfBytes(text, cutAt) {
    const buf = Buffer.from(text, 'utf-8');
    const parts = [];
    let prev = 0;
    for (const c of [...cutAt, buf.length]) {
        parts.push(buf.subarray(prev, c));
        prev = c;
    }
    return Readable.from(parts);
}

test('readUtf8: 中文字被切在字节中间也能完整还原', async () => {
    const text = '这样咱就不用撤回了';
    // "这" 占 3 字节，切在第 1 字节后 —— 旧写法在这里产出 ���
    const out = await readUtf8(streamOfBytes(text, [1]));
    assert.strictEqual(out, text);
    assert.ok(!out.includes('\uFFFD'), '不得出现替换字符');
});

test('readUtf8: 旧写法（逐块 += ）确实会碎，作为对照', async () => {
    const text = '这样咱就不用撤回了';
    let broken = '';
    for await (const chunk of streamOfBytes(text, [1])) broken += chunk;
    assert.ok(broken.includes('\uFFFD'), '对照：旧写法必然产出替换字符');
    assert.notStrictEqual(broken, text);
});

test('readUtf8: emoji（4 字节代理对）跨块同样不碎', async () => {
    const text = 'a😂b🐶c';
    for (const cut of [2, 3, 4]) {
        const out = await readUtf8(streamOfBytes(text, [cut]));
        assert.strictEqual(out, text, `切在第 ${cut} 字节处应无损`);
    }
});

test('readUtf8: 多个切点、逐字节切开也无损', async () => {
    const text = '一二三四五[doge]😂';
    const buf = Buffer.from(text, 'utf-8');
    const cuts = Array.from({ length: buf.length - 1 }, (_, i) => i + 1);
    assert.strictEqual(await readUtf8(streamOfBytes(text, cuts)), text);
});

test('readUtf8: 空流返回空串', async () => {
    assert.strictEqual(await readUtf8(Readable.from([])), '');
});

test('readUtf8: 超过字节上限时拒绝（防止无界内存）', async () => {
    await assert.rejects(
        () => readUtf8(streamOfBytes('x'.repeat(500), []), { maxBytes: 100 }),
        /上限/
    );
});

test('readUtf8: 流报错时拒绝', async () => {
    const s = new Readable({ read() { this.destroy(new Error('boom')); } });
    await assert.rejects(() => readUtf8(s), /boom/);
});
