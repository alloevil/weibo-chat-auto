const { test } = require('node:test');
const assert = require('node:assert');

async function load() {
    return import('../scripts/build-qa-index.mjs');
}

test('parseAnnotationResponse: 行式协议解析(全角/半角竖线)', async () => {
    const { parseAnnotationResponse } = await load();
    const out = parseAnnotationResponse('0|话题:半导体。结论:没跌到位。\n2｜话题:冲牙器"选购"指南\n废话行忽略', 3);
    assert.strictEqual(out[0], '话题:半导体。结论:没跌到位。');
    assert.strictEqual(out[1], null);
    assert.strictEqual(out[2], '话题:冲牙器"选购"指南'); // 引号不再是问题
});

test('parseAnnotationResponse: 越界编号忽略,无可解析行抛错', async () => {
    const { parseAnnotationResponse } = await load();
    const out = parseAnnotationResponse('0|ok\n9|越界', 2);
    assert.strictEqual(out[0], 'ok');
    assert.strictEqual(out[1], null);
    assert.throws(() => parseAnnotationResponse('完全没有格式', 2));
});

test('parseAnnotationResponse: 超长标注截断到 300 字', async () => {
    const { parseAnnotationResponse } = await load();
    const out = parseAnnotationResponse('0|' + 'x'.repeat(500), 1);
    assert.strictEqual(out[0].length, 300);
});

test('buildAnnotationPrompt: 包含块文本与行式格式说明', async () => {
    const { buildAnnotationPrompt } = await load();
    const p = buildAnnotationPrompt(['[10:00] a: 你好', '[11:00] b: 再见']);
    assert.match(p, /【块0】/);
    assert.match(p, /【块1】/);
    assert.match(p, /编号\|标注内容/);
});

test('annotateBatch: 请求形状与行式响应解析管道', async () => {
    const { annotateBatch, buildAnnotationPrompt, parseAnnotationResponse } = await load();
    const orig = global.fetch;
    try {
        const chunks = ['[10:00] a: 半导体聊天', '[11:00] b: 冲牙器聊天'];
        const content = '0|话题:半导体\n1|话题:冲牙器';
        let captured;
        global.fetch = async (url, init) => {
            captured = { url: String(url), init };
            return { ok: true, json: async () => ({ choices: [{ message: { content } }] }) };
        };
        const out = await annotateBatch({ baseUrl: 'https://llm.test/v1', apiKey: 'sk-k', model: 'gpt-x' }, chunks);

        assert.strictEqual(captured.url, 'https://llm.test/v1/chat/completions');
        assert.strictEqual(captured.init.headers['Authorization'], 'Bearer sk-k');
        const body = JSON.parse(captured.init.body);
        assert.strictEqual(body.model, 'gpt-x');
        assert.strictEqual(body.messages[0].content, buildAnnotationPrompt(chunks));
        // 期望数量必须与送入的块数一致，解析结果与直接解析 content 等价
        assert.deepStrictEqual(out, parseAnnotationResponse(content, chunks.length));
    } finally {
        global.fetch = orig;
    }
});

test('annotateBatch: 非 200 抛错并带状态码', async () => {
    const { annotateBatch } = await load();
    const orig = global.fetch;
    try {
        global.fetch = async () => ({ ok: false, status: 429 });
        await assert.rejects(() => annotateBatch({ baseUrl: 'x', apiKey: 'k', model: 'm' }, ['块']), /429/);
    } finally {
        global.fetch = orig;
    }
});
