const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const lock = require('../lib/sync-lock.js');

function tmpdir() {
    return fs.mkdtempSync(path.join(os.tmpdir(), 'sync-lock-test-'));
}

test('acquireLock: 空目录下获锁成功并写入 pid/startedAt', () => {
    const dir = tmpdir();
    const r = lock.acquireLock(dir, { pid: 1234, now: () => 5000 });
    assert.strictEqual(r.ok, true);
    const holder = JSON.parse(fs.readFileSync(path.join(dir, lock.LOCK_NAME), 'utf-8'));
    assert.deepStrictEqual(holder, { pid: 1234, startedAt: 5000 });
});

test('acquireLock: 持有者存活时拒绝重入', () => {
    const dir = tmpdir();
    assert.ok(lock.acquireLock(dir, { pid: 1, now: () => 1000 }).ok);
    const r = lock.acquireLock(dir, { pid: 2, now: () => 2000, isPidAlive: () => true });
    assert.strictEqual(r.ok, false);
    assert.match(r.reason, /pid 1/);
    // 锁文件仍属于第一个持有者
    assert.strictEqual(JSON.parse(fs.readFileSync(path.join(dir, lock.LOCK_NAME), 'utf-8')).pid, 1);
});

test('acquireLock: 持有者 pid 已死（kill -9 后）允许接管', () => {
    const dir = tmpdir();
    assert.ok(lock.acquireLock(dir, { pid: 1, now: () => 1000 }).ok);
    const r = lock.acquireLock(dir, { pid: 2, now: () => 2000, isPidAlive: () => false });
    assert.strictEqual(r.ok, true);
    assert.strictEqual(JSON.parse(fs.readFileSync(path.join(dir, lock.LOCK_NAME), 'utf-8')).pid, 2);
});

test('acquireLock: startedAt 超过 2 小时视为陈旧接管（防 pid 复用僵尸锁）', () => {
    const dir = tmpdir();
    assert.ok(lock.acquireLock(dir, { pid: 1, now: () => 0 }).ok);
    const r = lock.acquireLock(dir, {
        pid: 2,
        now: () => lock.STALE_MS + 1,
        isPidAlive: () => true, // pid 存活但锁过期 —— 仍然接管
    });
    assert.strictEqual(r.ok, true);
});

test('acquireLock: 损坏的锁文件视为陈旧接管', () => {
    const dir = tmpdir();
    fs.writeFileSync(path.join(dir, lock.LOCK_NAME), '{"pid": 1, "start');
    const r = lock.acquireLock(dir, { pid: 2, now: () => 1000 });
    assert.strictEqual(r.ok, true);
});

test('releaseLock: 释放后可重新获锁；不误删他人锁', () => {
    const dir = tmpdir();
    assert.ok(lock.acquireLock(dir, { pid: 1, now: () => 1000 }).ok);

    // pid 不匹配 → 拒绝释放
    assert.strictEqual(lock.releaseLock(dir, { pid: 99 }), false);
    assert.ok(fs.existsSync(path.join(dir, lock.LOCK_NAME)));

    // 本人释放 → 成功，且释放后其它进程可获锁
    assert.strictEqual(lock.releaseLock(dir, { pid: 1 }), true);
    assert.ok(!fs.existsSync(path.join(dir, lock.LOCK_NAME)));
    const r = lock.acquireLock(dir, { pid: 2, now: () => 2000, isPidAlive: () => true });
    assert.strictEqual(r.ok, true);
});

// /api/sync 的 409 判定条件：__syncProgress.running || isLocked(state/)。
// viewer-server 本体是不可 require 的整体脚本，这里覆盖它依赖的锁探测语义：
// 第一个 POST spawn 的归档器一获锁，第二个 POST 的 isLocked 必须立即为真。
test('isLocked: 归档器持锁期间为真（第二个 POST /api/sync 走 409），释放后为假', () => {
    const dir = tmpdir();
    const alive = () => true;

    assert.strictEqual(lock.isLocked(dir, { now: () => 0, isPidAlive: alive }), false, '无锁时可放行');

    assert.ok(lock.acquireLock(dir, { pid: 1, now: () => 1000 }).ok); // 第一个 POST 的归档器
    assert.strictEqual(lock.isLocked(dir, { now: () => 2000, isPidAlive: alive }), true, '第二个 POST 必须被拒');

    // 持有者已死 → 不再拦路（陈旧锁不该阻止手动 Sync）
    assert.strictEqual(lock.isLocked(dir, { now: () => 2000, isPidAlive: () => false }), false);

    lock.releaseLock(dir, { pid: 1 });
    assert.strictEqual(lock.isLocked(dir, { now: () => 3000, isPidAlive: alive }), false, '释放后放行');
});
