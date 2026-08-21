const { test } = require('node:test');
const assert = require('node:assert');
const { rewriteImageUrls } = require('../lib/rewrite-image-urls.js');
const exportChat = require('../lib/export-chat.js');

const ORIG_PIC = 'https://upload.api.weibo.com/2/mss/msget?source=209678993&fid=12345';
const ORIG_SHARE_PIC = 'https://wx1.sinaimg.cn/orj360/a.jpg';

function cacheFixture() {
    return [
        { id: 1, user: 'u', time: '2026/07/01 09:00:00', content: '图', pics: [ORIG_PIC] },
        { id: 2, user: 'u', time: '2026/07/01 09:01:00', content: '分享', share: { url: 'https://x', title: 't', pics: [ORIG_SHARE_PIC] } },
        { id: 3, user: 'u', time: '2026/07/01 09:02:00', content: '纯文本' },
    ];
}

test('rewriteImageUrls: 响应里是代理 URL', () => {
    const out = rewriteImageUrls(cacheFixture());
    assert.deepStrictEqual(out[0].pics, ['/api/image?fid=12345']);
    assert.deepStrictEqual(out[1].share.pics, [`/api/sinaimg?url=${encodeURIComponent(ORIG_SHARE_PIC)}`]);
    // 其余字段原样保留
    assert.strictEqual(out[0].content, '图');
    assert.strictEqual(out[1].share.url, 'https://x');
});

test('rewriteImageUrls: 缓存对象不被污染（#15 根因回归）', () => {
    const cache = cacheFixture();
    rewriteImageUrls(cache);
    assert.deepStrictEqual(cache[0].pics, [ORIG_PIC], '缓存 pics 必须保持原始 URL');
    assert.deepStrictEqual(cache[1].share.pics, [ORIG_SHARE_PIC], '缓存 share.pics 必须保持原始 URL');
});

test('rewriteImageUrls: 连续两次序列化同一份缓存，结果一致且无双重改写', () => {
    const cache = cacheFixture();
    const first = rewriteImageUrls(cache);
    const second = rewriteImageUrls(cache);
    assert.deepStrictEqual(second, first);
    assert.deepStrictEqual(second[0].pics, ['/api/image?fid=12345']);
});

test('rewriteImageUrls: 无 pics 的消息复用原对象（不做无谓拷贝）', () => {
    const cache = cacheFixture();
    const out = rewriteImageUrls(cache);
    assert.strictEqual(out[2], cache[2]);
});

test('端到端回归：先 /api/messages 序列化再导出，导出仍是原始 URL', () => {
    const cache = cacheFixture();
    // 模拟前端先刷了一遍 /api/messages（旧实现在这里污染缓存）
    rewriteImageUrls(cache);
    // 再走导出路径：直接读缓存
    const md = exportChat.renderMarkdown(cache, { group: 'g', date: '2026-07-01' });
    assert.ok(md.includes(`![图片](${ORIG_PIC})`), `导出应是原始 URL，实际:\n${md}`);
    assert.ok(!md.includes('/api/image?fid='), '导出不得含本地代理路径');

    const html = exportChat.renderHtml(cache, { group: 'g', date: '2026-07-01' });
    assert.ok(html.includes('https://upload.api.weibo.com/2/mss/msget?source=209678993&amp;fid=12345'));
    assert.ok(!html.includes('/api/image?fid='));
});
