const { test } = require('node:test');
const assert = require('node:assert');
const { buildPageScript } = require('../lib/page-hook.js');
const { createNormalizeMessage } = require('../lib/normalize-message.js');

test('USER_SCRIPT 与 lib/normalize-message 同源（内联副本漂移已消灭）', () => {
    const script = buildPageScript();
    // 同源证明：脚本里拼接的正是 lib 版 createNormalizeMessage 的函数体
    assert.ok(script.includes(createNormalizeMessage.toString()),
        'USER_SCRIPT 必须包含 lib 版 createNormalizeMessage 的完整源码');
    // 曾经漂移丢失的分支必须在（页内 hook 捕获的 p.large.url 图片消息丢 pics）
    assert.ok(script.includes('p.large?.url'), 'pic_urls 的 large.url 提取分支不得缺失');
});

test('USER_SCRIPT 可独立求值（工厂不引用 Node 侧作用域）', () => {
    const script = buildPageScript();
    // 模拟浏览器全局，整段脚本求值不得抛 ReferenceError
    const g = {
        fetch: async () => ({ clone: () => ({ json: async () => ({}) }) }),
        XMLHttpRequest: class { open() {} send() {} addEventListener() {} },
        console: { log: () => {} },
    };
    g.window = g;
    new Function('window', 'fetch', 'XMLHttpRequest', 'console', script)(
        g, g.fetch, g.XMLHttpRequest, g.console,
    );
    assert.ok(g.__ARCHIVER_STATE__, '脚本应装好 __ARCHIVER_STATE__');
    assert.strictEqual(g.__ARCHIVER_STATE__.getCount(), 0);
});

test('页内 normalize 对 large.url 图片消息不丢 pics（漂移事故回归）', () => {
    // 用与页面脚本相同的方式构造页内版 normalize
    const p2 = n => String(n).padStart(2, '0');
    const formatDate = ts => { const d = new Date(ts); return `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())}`; };
    const formatTime = ts => { const d = new Date(ts); return `${d.getFullYear()}/${p2(d.getMonth() + 1)}/${p2(d.getDate())} ${p2(d.getHours())}:${p2(d.getMinutes())}:${p2(d.getSeconds())}`; };
    const pageFactory = new Function(`return ${createNormalizeMessage.toString()}`)();
    const normalize = pageFactory({ formatDate, formatTime });

    const n = normalize({
        id: 7, time: 1700000000, from_user: { screen_name: 'u' },
        content: '图', pic_urls: [{ large: { url: 'http://wx1.sinaimg.cn/large/x.jpg' } }],
    });
    assert.deepStrictEqual(n.pics, ['https://wx1.sinaimg.cn/large/x.jpg']);

    // 与 Node 侧 lib 版逐字段一致（三来源硬约定）
    const { normalizeMessage } = require('../lib/normalize-message.js');
    const nodeSide = normalizeMessage({
        id: 7, time: 1700000000, from_user: { screen_name: 'u' },
        content: '图', pic_urls: [{ large: { url: 'http://wx1.sinaimg.cn/large/x.jpg' } }],
    });
    assert.deepStrictEqual(n, nodeSide);
});
