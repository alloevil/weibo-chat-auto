const { test } = require('node:test');
const assert = require('node:assert');
const { tokenize, search } = require('../lib/search-bm25.js');

test('tokenize：中文切 bigram，英文/数字整段小写', () => {
    assert.deepStrictEqual(tokenize('投资人'), ['投资', '资人']);
    assert.deepStrictEqual(tokenize('用GPT4分析'), ['用', 'gpt4', '分析']);
    assert.deepStrictEqual(tokenize('A股'), ['a', '股']);
    assert.deepStrictEqual(tokenize(''), []);
    assert.deepStrictEqual(tokenize('LLM'), ['llm']);
});

test('search：bigram 重叠带来部分匹配（"投资"命中"投资人"）', () => {
    const docs = ['今天聊了投资人的看法', '中午吃了火锅', '大盘走势不错'];
    const hits = search(docs, '投资');
    assert.ok(hits.length >= 1);
    assert.strictEqual(hits[0].idx, 0);
});

test('search：词频与文档长度影响排序（BM25 特性）', () => {
    const docs = [
        'AI AI AI 全是 AI 的讨论', // 高词频短文档
        '今天天气不错，顺便提了一句 AI，然后聊了很多别的事情什么的', // 低词频长文档
        '完全无关的内容',
    ];
    const hits = search(docs, 'AI');
    assert.strictEqual(hits[0].idx, 0, '高词频短文档应排最前');
    assert.ok(
        hits.some((h) => h.idx === 1),
        '低词频文档也应命中'
    );
    assert.ok(!hits.some((h) => h.idx === 2), '无关文档不命中');
});

test('search：多关键词查询聚合得分', () => {
    const docs = ['讨论大模型部署', '讨论前端框架', '大模型和前端都聊了'];
    const hits = search(docs, '大模型 前端');
    assert.strictEqual(hits[0].idx, 2, '同时命中两个关键词的文档应排最前');
});

test('search：空查询/空文档返回空', () => {
    assert.deepStrictEqual(search([], '投资'), []);
    assert.deepStrictEqual(search(['abc'], ''), []);
});

test('含点/连字符的拉丁段既保留整体也拆出各段（域名可检索）', () => {
    // 修复前：正则把 . 收进词内，github.com 是单一 token，搜 github 匹配不到
    assert.deepStrictEqual(tokenize('https://github.com/foo/bar'), [
        'https',
        'github.com',
        'github',
        'com',
        'foo',
        'bar',
    ]);
    // 保留整体是为了搜完整域名时它作为精确 token 拿到更高 idf
    assert.ok(tokenize('example.com').includes('example.com'));
    assert.ok(tokenize('example.com').includes('example'));
});

test('搜域名片段能命中含 URL 的文档', () => {
    const docs = ['看这个 https://github.com/foo/bar 库', '别的事', 'arxiv.org/abs/2605 这篇'];
    assert.deepStrictEqual(
        search(docs, 'github', { limit: 5 }).map((h) => h.idx),
        [0]
    );
    assert.deepStrictEqual(
        search(docs, 'arxiv', { limit: 5 }).map((h) => h.idx),
        [2]
    );
    // 完整域名仍然可搜
    assert.deepStrictEqual(
        search(docs, 'github.com', { limit: 5 }).map((h) => h.idx),
        [0]
    );
});

test('纯标点段不产生空 token', () => {
    for (const s of ['...', '--', '.', '-.-']) {
        assert.ok(
            tokenize(s).every((t) => t.length > 0),
            `"${s}" 不该产出空 token`
        );
    }
});
