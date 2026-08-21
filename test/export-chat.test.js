const { test } = require('node:test');
const assert = require('node:assert');
const ex = require('../lib/export-chat.js');

// 与查看器 processForward 同一协议的转发消息样本
const SEP = ' - - - - - - - - - - - - - - - ';
const messages = [
    { id: 1, user: '张三', timestamp: 1000, time: '2026/07/01 09:05:00', date: '2026-07-01', content: '早上好，今天开会' },
    { id: 2, user: '李四', timestamp: 2000, time: '2026/07/01 09:06:30', date: '2026-07-01', content: `「早上好，今天开会」${SEP}收到，几点？` },
    { id: 3, user: '王五', timestamp: 3000, time: '2026/07/01 09:07:00', date: '2026-07-01', content: '[doge] 我也来 [未知表情]' },
    { id: 4, user: '张三', timestamp: 4000, time: '2026/07/01 09:08:00', date: '2026-07-01', content: '看图', pics: ['https://upload.api.weibo.com/2/mss/msget?source=209678993&fid=12345'] },
    { id: 5, user: 'bot', timestamp: 5000, time: '2026/07/01 09:09:00', date: '2026-07-01', content: '收到红包消息' },
];

test('parseForward: 拆出引用与回复；普通消息 quote 为 null', () => {
    assert.deepStrictEqual(ex.parseForward('普通消息'), { quote: null, reply: '普通消息' });
    const f = ex.parseForward(`「原文」${SEP}回复内容`);
    assert.strictEqual(f.quote, '原文');
    assert.strictEqual(f.reply, '回复内容');
    // 嵌套「」不提前截断
    const nested = ex.parseForward(`「他说「好」的」${SEP}嗯`);
    assert.strictEqual(nested.quote, '他说「好」的');
});

test('filterMessages: 默认滤掉红包/噪音，keepNoise 保留', () => {
    assert.deepStrictEqual(ex.filterMessages(messages).map(m => m.id), [1, 2, 3, 4]);
    assert.strictEqual(ex.filterMessages(messages, { keepNoise: true }).length, 5);
});

test('renderMarkdown: 时间戳/昵称/引用 blockquote/图片 URL', () => {
    const md = ex.renderMarkdown(ex.filterMessages(messages), { group: '测试群', date: '2026-07-01' });
    assert.ok(md.startsWith('# 测试群 2026-07-01'), '标题含群名与日期');
    assert.ok(md.includes('[09:05] 张三: 早上好，今天开会'), '[HH:MM] 昵称: 消息');
    // 引用为 blockquote 且带原作者（原消息在当天可解析出张三）
    assert.ok(md.includes('> 张三：早上好，今天开会'), `引用应带原作者，实际:\n${md}`);
    assert.ok(md.includes('收到，几点？'), '回复正文保留');
    // 表情保留 [label] 文本
    assert.ok(md.includes('[doge] 我也来 [未知表情]'));
    // 图片输出原始 URL
    assert.ok(md.includes('![图片](https://upload.api.weibo.com/2/mss/msget?source=209678993&fid=12345)'));
    // 默认过滤了红包
    assert.ok(!md.includes('收到红包消息'));
});

test('renderHtml: 自包含（无外部 css/js 引用）、引用带原作者、表情不丢', () => {
    const html = ex.renderHtml(ex.filterMessages(messages), { group: '测试群', date: '2026-07-01' });
    // 自包含：无外部引用，样式内联
    assert.ok(!/<link\b/i.test(html), '不得有 <link>');
    assert.ok(!/<script\b/i.test(html), '不得有 <script>');
    assert.ok(!/src="https?:\/\/(?!upload\.api\.weibo\.com|wx\d\.sinaimg\.cn)/.test(html), '除消息图片外不得引用外部资源');
    assert.ok(html.includes('<style>'), 'CSS 内联');
    // 结构与内容
    assert.ok(html.includes('张三'), '昵称');
    assert.ok(html.includes('09:05'), '时间');
    assert.ok(html.includes('class="forward-quote"'), '引用块');
    assert.ok(html.includes('<span class="quote-author">张三：</span>'), '引用带原作者');
    // 表情：内置表命中转 Unicode，未命中保留 [label]
    assert.ok(html.includes('🐶'), '[doge] 转 Unicode');
    assert.ok(html.includes('[未知表情]'), '未知表情保留标签');
    // 图片还原为原始 URL（属性内 & 转义为 &amp;）
    assert.ok(html.includes('https://upload.api.weibo.com/2/mss/msget?source=209678993&amp;fid=12345'));
});

test('renderHtml: 内容经过 HTML 转义', () => {
    const html = ex.renderHtml([
        { id: 9, user: '<b>x</b>', time: '2026/07/01 10:00:00', content: '<script>alert(1)</script>' },
    ], { group: 'g', date: '2026-07-01' });
    assert.ok(!html.includes('<script>alert'), '正文脚本被转义');
    assert.ok(html.includes('&lt;script&gt;alert(1)&lt;/script&gt;'));
    assert.ok(html.includes('&lt;b&gt;x&lt;/b&gt;'), '昵称被转义');
});
