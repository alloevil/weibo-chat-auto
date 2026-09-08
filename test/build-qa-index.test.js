const { test } = require('node:test');
const assert = require('node:assert');

async function load() {
    return import('../scripts/build-qa-index.mjs');
}

test('parseAnnotationResponse: 行式协议解析(全角/半角竖线)', async () => {
    const { parseAnnotationResponse } = await load();
    const out = parseAnnotationResponse(
        '0|话题:半导体。结论:没跌到位。\n2｜话题:冲牙器"选购"指南\n废话行忽略',
        3
    );
    assert.strictEqual(out[0].annotation, '话题:半导体。结论:没跌到位。');
    assert.strictEqual(out[1], null);
    assert.strictEqual(out[2].annotation, '话题:冲牙器"选购"指南'); // 引号不再是问题
});

test('parseAnnotationResponse: 越界编号忽略,无可解析行抛错', async () => {
    const { parseAnnotationResponse } = await load();
    const out = parseAnnotationResponse('0|ok\n9|越界', 2);
    assert.strictEqual(out[0].annotation, 'ok');
    assert.strictEqual(out[1], null);
    assert.throws(() => parseAnnotationResponse('完全没有格式', 2));
});

test('parseAnnotationResponse: 超长标注截断到 300 字', async () => {
    const { parseAnnotationResponse } = await load();
    const out = parseAnnotationResponse('0|' + 'x'.repeat(500), 1);
    assert.strictEqual(out[0].annotation.length, 300);
});

test('parseAnnotationResponse: 解析别名行(A 段),按 / 切分', async () => {
    const { parseAnnotationResponse } = await load();
    const out = parseAnnotationResponse(
        '0|话题:半导体行情。\n0|A|减持科技股/看空芯片/调整投资仓位\n1|话题:冲牙器。\n1|A|口腔清洁设备',
        2
    );
    assert.deepStrictEqual(out[0].aliases, ['减持科技股', '看空芯片', '调整投资仓位']);
    assert.deepStrictEqual(out[1].aliases, ['口腔清洁设备']);
});

test('parseAnnotationResponse: 别名行不会被摘要正则吞掉', async () => {
    const { parseAnnotationResponse } = await load();
    // 若先匹配摘要正则，annotation 会变成 "A|减持科技股"
    const out = parseAnnotationResponse('0|A|减持科技股/看空芯片\n0|话题:半导体。', 1);
    assert.strictEqual(out[0].annotation, '话题:半导体。');
    assert.deepStrictEqual(out[0].aliases, ['减持科技股', '看空芯片']);
});

test('parseAnnotationResponse: 缺别名行仍算成功(别名是增量优化)', async () => {
    const { parseAnnotationResponse } = await load();
    const out = parseAnnotationResponse('0|只有摘要没有别名', 1);
    assert.strictEqual(out[0].annotation, '只有摘要没有别名');
    assert.deepStrictEqual(out[0].aliases, []);
});

test('parseAnnotationResponse: 只有别名没摘要的条目视为无效', async () => {
    const { parseAnnotationResponse } = await load();
    // 摘要是检索文本主体；只有别名会让 snippet 无从生成
    assert.throws(() => parseAnnotationResponse('0|A|孤立别名', 1));
});

test('parseAnnotationResponse: 别名上限 4 条、单条截断 60 字', async () => {
    const { parseAnnotationResponse } = await load();
    const many = ['a', 'b', 'c', 'd', 'e', 'f'].join('/');
    const out = parseAnnotationResponse(`0|摘要\n0|A|${many}`, 1);
    assert.strictEqual(out[0].aliases.length, 4);

    const long = parseAnnotationResponse(`0|摘要\n0|A|${'y'.repeat(200)}`, 1);
    assert.strictEqual(long[0].aliases[0].length, 60);
});

test('buildAnnotationPrompt: 含块文本、两行格式、以及「不同词汇」约束', async () => {
    const { buildAnnotationPrompt } = await load();
    const p = buildAnnotationPrompt(['[10:00] a: 你好', '[11:00] b: 再见']);
    assert.match(p, /【块0】/);
    assert.match(p, /【块1】/);
    assert.match(p, /编号\|摘要/);
    assert.match(p, /编号\|A\|/);
    // 关键约束：只换语序不换词的改写对 bigram BM25 无增益
    assert.match(p, /完全不同的词汇/);
});
