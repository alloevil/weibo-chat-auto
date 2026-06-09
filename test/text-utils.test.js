const { test } = require('node:test');
const assert = require('node:assert');
const t = require('../lib/text-utils.js');

test('escapeHtml 转义 HTML 特殊字符', () => {
    assert.strictEqual(t.escapeHtml('<a href="x">&'), '&lt;a href=&quot;x&quot;&gt;&amp;');
    assert.strictEqual(t.escapeHtml(''), '');
    assert.strictEqual(t.escapeHtml(null), '');
    assert.strictEqual(t.escapeHtml('纯文本'), '纯文本');
});

test('escapeAttr 额外转义单引号', () => {
    assert.strictEqual(t.escapeAttr("it's <b>"), 'it&#39;s &lt;b&gt;');
});

test('processEmoji 已知表情转 Unicode，未知保留为标签', () => {
    assert.strictEqual(t.processEmoji('[doge]'), '<span class="emoji">🐶</span>');
    assert.strictEqual(t.processEmoji('[未知表情]'), '<span class="emoji-unknown">[未知表情]</span>');
    assert.strictEqual(t.processEmoji('无表情'), '无表情');
    // 多个表情
    assert.ok(t.processEmoji('[赞][哈哈]').includes('👍'));
});

test('processMentions 高亮 @用户名', () => {
    assert.strictEqual(t.processMentions('@小明'), '<span class="mention">@小明</span>');
    assert.strictEqual(t.processMentions('hi @Alice 你好'), 'hi <span class="mention">@Alice</span> 你好');
    // 不误伤邮箱（@ 前无边界）
    assert.strictEqual(t.processMentions('a@b.com'), 'a@b.com');
    // 多个提及
    const out = t.processMentions('@张三 @李四');
    assert.strictEqual((out.match(/class="mention"/g) || []).length, 2);
});

test('normForQuote 去空白并截前 30 字', () => {
    assert.strictEqual(t.normForQuote('  你 好  世界 '), '你好世界');
    assert.strictEqual(t.normForQuote(null), '');
    assert.strictEqual(t.normForQuote('a'.repeat(40)).length, 30);
    // 零宽空格也应去除
    assert.strictEqual(t.normForQuote('你​好'), '你好');
});

test('periodOf 按小时分段', () => {
    const at = (h) => t.periodOf(new Date(2026, 5, 9, h, 0, 0).getTime());
    assert.strictEqual(at(2).key, 'dawn');
    assert.strictEqual(at(9).key, 'morning');
    assert.strictEqual(at(14).key, 'afternoon');
    assert.strictEqual(at(20).key, 'evening');
    assert.strictEqual(at(0).label, '凌晨');
    assert.strictEqual(at(23).label, '晚上');
});

test('processUrls 链接化，图片 URL 加缩略图', () => {
    const plain = t.processUrls('看 http://t.cn/abc');
    assert.ok(plain.includes('<a href="http://t.cn/abc"'));
    assert.ok(!plain.includes('<img'));
    const img = t.processUrls('https://x.com/a.jpg');
    assert.ok(img.includes('<img src='));
    // 长 URL 显示截断
    const long = 'https://example.com/' + 'a'.repeat(80);
    assert.ok(t.processUrls(long).includes('...'));
});

test('highlightText 高亮匹配（大小写不敏感、正则安全）', () => {
    assert.strictEqual(t.highlightText('Hello', 'hello'),
        '<span class="search-highlight">Hello</span>');
    assert.strictEqual(t.highlightText('abc', ''), 'abc');
    // 特殊字符不应破坏正则
    assert.doesNotThrow(() => t.highlightText('a.b(c)', '.('));
});

test('isNoise 识别噪声消息', () => {
    // 问候/纯标点
    assert.strictEqual(t.isNoise({ content: '早' }), true);
    assert.strictEqual(t.isNoise({ content: '。。。' }), true);
    assert.strictEqual(t.isNoise({ content: '👍👍' }), true);
    // 红包系统消息
    assert.strictEqual(t.isNoise({ content: '收到红包消息' }), true);
    assert.strictEqual(t.isNoise({ content: '小明领取了你的红包' }), true);
    assert.strictEqual(t.isNoise({ content: '恭喜获得最佳手气' }), true);
    assert.strictEqual(t.isNoise({ content: '5.20元，@张三' }), true);
    // 正常消息不应误判
    assert.strictEqual(t.isNoise({ content: '今天天气不错' }), false);
    assert.strictEqual(t.isNoise({ content: '早上好，今天开会' }), false);
    assert.strictEqual(t.isNoise({ content: '' }), false);
    assert.strictEqual(t.isNoise({}), false);
});
