const { test } = require('node:test');
const assert = require('node:assert');
const { parseVersion, isNewer, extractLatest, createVersionChecker, CURRENT_VERSION } = require('../lib/version-check.js');

test('parseVersion: 接受 v 前缀与裸版本,拒绝垃圾输入', () => {
    assert.deepStrictEqual(parseVersion('v1.23.0'), [1, 23, 0]);
    assert.deepStrictEqual(parseVersion('1.2.3'), [1, 2, 3]);
    assert.strictEqual(parseVersion('latest'), null);
    assert.strictEqual(parseVersion(''), null);
    assert.strictEqual(parseVersion(null), null);
});

test('isNewer: 严格大于才算新版;解析失败一律 false(不误报)', () => {
    assert.strictEqual(isNewer('v1.24.0', '1.23.0'), true);
    assert.strictEqual(isNewer('v2.0.0', '1.99.99'), true);
    assert.strictEqual(isNewer('v1.23.0', '1.23.0'), false);
    assert.strictEqual(isNewer('v1.22.9', '1.23.0'), false);
    assert.strictEqual(isNewer('garbage', '1.23.0'), false);
    assert.strictEqual(isNewer('v1.24.0', 'garbage'), false);
});

test('extractLatest: 正常响应取 tag_name/html_url;缺 tag_name 返回 null', () => {
    const r = extractLatest({ tag_name: 'v9.9.9', html_url: 'https://x/releases/v9.9.9' });
    assert.deepStrictEqual(r, { tag: 'v9.9.9', url: 'https://x/releases/v9.9.9' });
    assert.strictEqual(extractLatest({ message: 'API rate limit exceeded' }), null);
    assert.strictEqual(extractLatest(null), null);
    // html_url 缺失时回退到 releases/latest 固定链接
    assert.match(extractLatest({ tag_name: 'v1.0.0' }).url, /releases\/latest$/);
});

test('checker: 有新版时 updateAvailable=true,并携带当前版本号', async () => {
    const checker = createVersionChecker({
        currentVersion: '1.23.0',
        fetchLatest: async () => ({ tag_name: 'v1.24.0', html_url: 'https://x/v1.24.0' }),
    });
    const r = await checker.check();
    assert.strictEqual(r.updateAvailable, true);
    assert.strictEqual(r.latestTag, 'v1.24.0');
    assert.strictEqual(r.version, '1.23.0');
});

test('checker: 网络失败静默——ok 仍为 true,updateAvailable=false,失败结果也进缓存', async () => {
    let calls = 0;
    let t = 0;
    const checker = createVersionChecker({
        currentVersion: '1.23.0',
        ttlMs: 1000,
        now: () => t,
        fetchLatest: async () => { calls++; throw new Error('offline'); },
    });
    const r1 = await checker.check();
    assert.strictEqual(r1.ok, true);
    assert.strictEqual(r1.updateAvailable, false);
    assert.strictEqual(r1.latestTag, null);
    // TTL 内不重试网络(离线时每次开设置都发请求就太吵了)
    await checker.check();
    assert.strictEqual(calls, 1);
    // TTL 过期后重试
    t = 1001;
    await checker.check();
    assert.strictEqual(calls, 2);
});

test('checker: TTL 内命中缓存,只发一次网络请求', async () => {
    let calls = 0;
    const checker = createVersionChecker({
        currentVersion: '1.23.0',
        ttlMs: 60000,
        now: () => 0,
        fetchLatest: async () => { calls++; return { tag_name: 'v1.23.0' }; },
    });
    const [a, b] = await Promise.all([checker.check(), checker.check()]);
    await checker.check();
    assert.strictEqual(calls, 1, '并发与后续调用共享同一次请求');
    assert.strictEqual(a.updateAvailable, false);
    assert.strictEqual(b.latestTag, 'v1.23.0');
});

test('CURRENT_VERSION 与 package.json/tauri.conf.json 一致(版本号单一事实源检查)', () => {
    const pkg = require('../package.json');
    const tauri = require('../src-tauri/tauri.conf.json');
    assert.strictEqual(CURRENT_VERSION, pkg.version);
    assert.strictEqual(tauri.version, pkg.version, 'tauri.conf.json 版本需与 package.json 同步');
});
