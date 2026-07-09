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
