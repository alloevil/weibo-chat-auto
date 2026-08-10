const { test } = require('node:test');
const assert = require('node:assert');
const { isCrossSiteRequest } = require('../lib/csrf-guard.js');

// 判据必须同时满足两件事，缺一不可：
//   1. 拦住浏览器里任意网页发起的跨站写操作（CSRF，实测可利用）
//   2. 不拦 curl / Tauri Rust 侧这类无 Origin 的本机调用

test('无 Origin 放行：curl、Tauri Rust 侧轮询都没有 Origin', () => {
    assert.strictEqual(isCrossSiteRequest({}), false);
    assert.strictEqual(isCrossSiteRequest({ origin: undefined }), false);
});

test('本机 Origin 放行（页面自己的 fetch / 桌面版 WebView）', () => {
    for (const o of ['http://127.0.0.1:3456', 'http://localhost:3456', 'http://[::1]:3456']) {
        assert.strictEqual(isCrossSiteRequest({ origin: o }), false, o);
    }
});

test('外站 Origin 拦截 —— 这正是实测可利用的那条路径', () => {
    for (const o of ['https://evil.example.com', 'http://weibo.com', 'https://127.0.0.1.evil.com']) {
        assert.strictEqual(isCrossSiteRequest({ origin: o }), true, o);
    }
});

test('畸形或 null Origin：畸形按跨站处理，"null" 按无 Origin 处理', () => {
    assert.strictEqual(isCrossSiteRequest({ origin: 'not a url' }), true);
    // Origin: null 来自 sandbox iframe / file://，浏览器不会给它跨站 form POST
    // 的能力去伪造本机来源，按无 Origin 放行（否则会误伤桌面壳的边缘场景）
    assert.strictEqual(isCrossSiteRequest({ origin: 'null' }), false);
});

test('Sec-Fetch-Site 优先：浏览器自打的标记，攻击页改不了', () => {
    assert.strictEqual(isCrossSiteRequest({ 'sec-fetch-site': 'same-origin' }), false);
    assert.strictEqual(isCrossSiteRequest({ 'sec-fetch-site': 'none' }), false);
    assert.strictEqual(isCrossSiteRequest({ 'sec-fetch-site': 'cross-site' }), true);
    assert.strictEqual(isCrossSiteRequest({ 'sec-fetch-site': 'same-site' }), true);
    // 即使 Origin 伪装成本机，cross-site 标记也必须拦住
    assert.strictEqual(isCrossSiteRequest({
        'sec-fetch-site': 'cross-site', origin: 'http://127.0.0.1:3456',
    }), true);
});
