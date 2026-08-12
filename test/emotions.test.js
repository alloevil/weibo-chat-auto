const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const em = require('../lib/emotions.js');
const tu = require('../lib/text-utils.js');

const tmpFile = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'emotions-test-')), 'emotions.json');

const officialList = [
    { phrase: '[卡皮巴拉]', url: 'https://face.t.sinajs.cn/x/capybara.png', icon: 'https://face.t.sinajs.cn/x/capybara_s.png' },
    { phrase: '[锦鲤附体]', url: 'https://face.t.sinajs.cn/x/koi.png' },
    { value: '[备用字段]', icon: 'https://face.t.sinajs.cn/x/fallback.png' },   // 只有 value/icon
    { phrase: 'not-a-tag', url: 'https://face.t.sinajs.cn/x/no.png' },          // 非 [..] 形式
    { phrase: '[坏链]', url: 'ftp://weird' },                                    // 非 http(s)
    null,
];

function fakeFetch(body, { fail = false } = {}) {
    let calls = 0;
    const impl = async () => {
        calls++;
        if (fail) throw new Error('network down');
        return { json: async () => body };
    };
    Object.defineProperty(impl, 'calls', { get: () => calls });
    return impl;
}

test('toPhraseMap: 只收 [标签] + http(s) URL，兼容 value/icon 字段', () => {
    const map = em.toPhraseMap(officialList);
    assert.strictEqual(map['[卡皮巴拉]'], 'https://face.t.sinajs.cn/x/capybara.png');
    assert.strictEqual(map['[备用字段]'], 'https://face.t.sinajs.cn/x/fallback.png');
    assert.ok(!('not-a-tag' in map));
    assert.ok(!('[坏链]' in map));
    assert.deepStrictEqual(em.toPhraseMap(null), {});
});

test('loadEmotions: 首次拉取并写缓存，之后命中缓存不再打网络', async () => {
    const file = tmpFile();
    const impl = fakeFetch(officialList);

    const first = await em.loadEmotions(file, { fetchImpl: impl });
    assert.strictEqual(first.source, 'network');
    assert.ok(first.count >= 3);
    assert.ok(fs.existsSync(file), '必须落盘缓存');

    const second = await em.loadEmotions(file, { fetchImpl: impl });
    assert.strictEqual(second.source, 'cache');
    assert.strictEqual(impl.calls, 1, '缓存新鲜时不得重复拉取');
});

test('loadEmotions: 缓存过期则重新拉取', async () => {
    const file = tmpFile();
    const impl = fakeFetch(officialList);
    await em.loadEmotions(file, { fetchImpl: impl });
    const later = await em.loadEmotions(file, { fetchImpl: impl, now: Date.now() + em.TTL_MS + 1 });
    assert.strictEqual(later.source, 'network');
    assert.strictEqual(impl.calls, 2);
});

test('loadEmotions: 网络失败时用过期缓存，绝不退回空表', async () => {
    const file = tmpFile();
    await em.loadEmotions(file, { fetchImpl: fakeFetch(officialList) });
    const stale = await em.loadEmotions(file, {
        fetchImpl: fakeFetch(null, { fail: true }),
        now: Date.now() + em.TTL_MS + 1,
    });
    assert.strictEqual(stale.source, 'stale');
    assert.strictEqual(stale.map['[卡皮巴拉]'], 'https://face.t.sinajs.cn/x/capybara.png');
});

test('loadEmotions: 无缓存且拉取失败时安全返回空表', async () => {
    const r = await em.loadEmotions(tmpFile(), { fetchImpl: fakeFetch(null, { fail: true }) });
    assert.deepStrictEqual([r.source, r.count], ['empty', 0]);
});

test('loadEmotions: 清单为空视为失败（不要把空表写进缓存）', async () => {
    const file = tmpFile();
    const r = await em.loadEmotions(file, { fetchImpl: fakeFetch([]) });
    assert.strictEqual(r.source, 'empty');
    assert.ok(!fs.existsSync(file), '空清单不得落盘，否则 7 天内都不会再试');
});

// ── 渲染侧：三级回退 ──────────────────────────────────────────────

test('processEmoji: 内置 Unicode 表优先于图片', () => {
    const html = tu.processEmoji('哈[doge]哈', () => 'https://example.com/should-not-win.png');
    assert.match(html, /🐶/);
    assert.ok(!html.includes('<img'), 'Unicode 能表达时不该退化成图片');
});

test('processEmoji: 官方清单命中时渲染为图片并保留原标签文本', () => {
    const map = { '[卡皮巴拉]': 'https://face.t.sinajs.cn/x/capybara.png' };
    const html = tu.processEmoji('看[卡皮巴拉]', (tag) => map[tag] || null);
    assert.match(html, /<img class="emoji-img" src="https:\/\/face\.t\.sinajs\.cn\/x\/capybara\.png"/);
    assert.match(html, /alt="\[卡皮巴拉\]"/, 'alt 要保留原标签，图挂了也知道是什么表情');
});

test('processEmoji: 旧式 [/eeXXXX.png] 拼 CDN 地址（Unicode 无对应）', () => {
    const html = tu.processEmoji('旧[/ee8c92.png]式');
    assert.match(html, /src="https:\/\/img\.t\.sinajs\.cn\/t4\/appstyle\/expression\/emimage\/ee8c92\.png"/);
});

test('processEmoji: 三级都不中时保留原文，不吞内容', () => {
    const html = tu.processEmoji('陌生[某个新表情]标签', () => null);
    assert.match(html, /<span class="emoji-unknown">\[某个新表情\]<\/span>/);
});

test('processEmoji: 不传 resolver 时行为与旧版一致（Node 侧调用方无需改动）', () => {
    const html = tu.processEmoji('[doge][未知]');
    assert.match(html, /🐶/);
    assert.match(html, /emoji-unknown/);
});

test('processEmoji: URL 中的引号被转义，防止属性注入', () => {
    const html = tu.processEmoji('[x]', () => 'https://e.com/a.png" onerror="alert(1)');
    assert.ok(!html.includes('onerror="alert(1)"'), '注入的属性必须被转义');
    assert.match(html, /&quot;/);
});
