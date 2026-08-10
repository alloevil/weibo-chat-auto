const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const cs = require('../lib/cache-store.js');

const DAY = 24 * 3600 * 1000;
const NOW = Date.parse('2026-08-10T12:00:00Z');
const e = (name, sizeMB, ageDays) => ({ name, size: sizeMB * 1024 * 1024, mtime: NOW - ageDays * DAY });

function tmpCache(files) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cache-store-test-'));
    for (const [name, sizeBytes, ageDays] of files) {
        const p = path.join(dir, name);
        fs.writeFileSync(p, Buffer.alloc(sizeBytes, 1));
        const t = new Date(NOW - ageDays * DAY);
        fs.utimesSync(p, t, t);
    }
    return dir;
}

test('planEviction: 容量以内且不超龄时一个都不删', () => {
    const plan = cs.planEviction([e('a', 10, 1), e('b', 20, 2)], { maxBytes: 100 * 1024 * 1024, maxAgeMs: 90 * DAY, now: NOW });
    assert.deepStrictEqual(plan.names, []);
    assert.strictEqual(plan.freedBytes, 0);
});

test('planEviction: 超龄条目一律淘汰，即使总量没超', () => {
    const plan = cs.planEviction(
        [e('old', 1, 200), e('fresh', 1, 1)],
        { maxBytes: 1024 * 1024 * 1024, maxAgeMs: 90 * DAY, now: NOW }
    );
    assert.deepStrictEqual(plan.names, ['old']);
});

test('planEviction: 超容量时按最久未使用淘汰，直到压回上限以内', () => {
    // 4 个 100MB，上限 250MB → 需删掉最老的两个
    const entries = [e('d4', 100, 1), e('d3', 100, 2), e('d2', 100, 3), e('d1', 100, 4)];
    const plan = cs.planEviction(entries, { maxBytes: 250 * 1024 * 1024, maxAgeMs: 0, now: NOW });
    assert.deepStrictEqual(plan.names, ['d1', 'd2'], '最老的先走');
    assert.strictEqual(plan.remainingBytes, 200 * 1024 * 1024);
});

test('planEviction: 年龄与容量叠加时不重复计算同一条目', () => {
    const entries = [e('old', 100, 200), e('mid', 100, 5), e('new', 100, 1)];
    const plan = cs.planEviction(entries, { maxBytes: 150 * 1024 * 1024, maxAgeMs: 90 * DAY, now: NOW });
    // old 超龄先删（剩 200MB），仍超 150MB → 再删最老的 mid
    assert.deepStrictEqual(plan.names, ['old', 'mid']);
    assert.strictEqual(new Set(plan.names).size, plan.names.length, '同一条目不得出现两次');
    assert.strictEqual(plan.remainingBytes, 100 * 1024 * 1024);
});

test('evictCache: 真删文件并如实报告释放量', () => {
    const dir = tmpCache([['a.jpg', 3 * 1024 * 1024, 200], ['b.jpg', 1024, 1]]);
    const r = cs.evictCache(dir, { maxBytes: 10 * 1024 * 1024, maxAgeMs: 90 * DAY, now: NOW });
    assert.strictEqual(r.deleted, 1);
    assert.strictEqual(r.freedBytes, 3 * 1024 * 1024);
    assert.deepStrictEqual(fs.readdirSync(dir), ['b.jpg'], '未超龄的必须留下');
    fs.rmSync(dir, { recursive: true, force: true });
});

test('evictCache: 目录不存在时安全返回，不抛错', () => {
    const r = cs.evictCache(path.join(os.tmpdir(), 'cache-store-does-not-exist-' + Date.now()));
    assert.deepStrictEqual([r.deleted, r.freedBytes], [0, 0]);
});

test('listEntries: 只看普通文件，跳过子目录与符号链接', () => {
    const dir = tmpCache([['keep.jpg', 100, 1]]);
    fs.mkdirSync(path.join(dir, 'sub'));
    fs.symlinkSync('/etc/hosts', path.join(dir, 'link.jpg'));   // 绝不能被当缓存删掉
    const names = cs.listEntries(dir).map(x => x.name);
    assert.deepStrictEqual(names, ['keep.jpg']);
    fs.rmSync(dir, { recursive: true, force: true });
});

test('isCacheable: 拒绝超大条目（视频被当图片缓存过，单个 75MB）', () => {
    assert.strictEqual(cs.isCacheable(500 * 1024), true);
    assert.strictEqual(cs.isCacheable(cs.MAX_ENTRY_BYTES), true);
    assert.strictEqual(cs.isCacheable(cs.MAX_ENTRY_BYTES + 1), false);
    assert.strictEqual(cs.isCacheable(0), false);
    assert.strictEqual(cs.isCacheable(NaN), false);
});
