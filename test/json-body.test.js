const { test } = require('node:test');
const assert = require('node:assert');
const { Readable } = require('stream');
const { DEFAULT_MAX_BYTES, readJsonBody } = require('../lib/json-body');

test('readJsonBody: 正确解析跨 chunk 的中文 JSON', async () => {
    const bytes = Buffer.from(JSON.stringify({ content: '这样😂' }));
    const value = await readJsonBody(Readable.from([bytes.subarray(0, 3), bytes.subarray(3)]));
    assert.deepStrictEqual(value, { content: '这样😂' });
});

test('readJsonBody: 畸形 JSON 返回可映射到 HTTP 400 的错误', async () => {
    await assert.rejects(
        () => readJsonBody(Readable.from(['{"broken"'])),
        (e) => e.statusCode === 400 && /参数解析失败/.test(e.message)
    );
});

test('readJsonBody: 超过字节上限返回 413，默认上限保持有界', async () => {
    assert.strictEqual(DEFAULT_MAX_BYTES, 64 * 1024);
    await assert.rejects(
        () => readJsonBody(Readable.from(['x'.repeat(101)]), { maxBytes: 100 }),
        (e) => e.statusCode === 413 && /100 字节上限/.test(e.message)
    );
});

test('readJsonBody: 输入流失败时包装为 400 且保留原因', async () => {
    const stream = new Readable({
        read() {
            this.destroy(new Error('boom'));
        },
    });
    await assert.rejects(
        () => readJsonBody(stream),
        (e) => e.statusCode === 400 && /boom/.test(e.message)
    );
});
