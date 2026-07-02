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
        'AI AI AI 全是 AI 的讨论',                             // 高词频短文档
        '今天天气不错，顺便提了一句 AI，然后聊了很多别的事情什么的', // 低词频长文档
        '完全无关的内容',
    ];
    const hits = search(docs, 'AI');
    assert.strictEqual(hits[0].idx, 0, '高词频短文档应排最前');
    assert.ok(hits.some(h => h.idx === 1), '低词频文档也应命中');
    assert.ok(!hits.some(h => h.idx === 2), '无关文档不命中');
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
