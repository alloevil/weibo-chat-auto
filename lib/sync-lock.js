// 归档器跨进程互斥锁（#14）。
//
// 两条并发路径都真实存在：前端双击 Sync Now、手动 Sync 撞上定时归档。
// 两个 puppeteer 实例同时登录同一微博会话会互相抢占，轻则归档中断，
// 重则触发风控导致 cookie 失效 —— 这是本项目最昂贵的失败模式。
//
// 锁形态：state/sync.lock，内容为 JSON { pid, startedAt }。
// 用 'wx' 独占创建保证原子性；已存在时检查陈旧（持有者 pid 已死、
// 或 startedAt 超过 STALE_MS）—— 陈旧则接管，否则拒绝。
// kill -9 不会走 finally，所以"pid 已死即陈旧"是崩溃后能自愈的关键。

const fs = require('fs');
const path = require('path');

const LOCK_NAME = 'sync.lock';
// 归档单轮上限远小于 2 小时（viewer 侧 spawn 就有 10 分钟 SIGKILL 兜底）；
// 超过 2 小时的锁只可能是 pid 被复用的僵尸记录，直接接管。
const STALE_MS = 2 * 60 * 60 * 1000;

function defaultIsPidAlive(pid) {
    try {
        process.kill(pid, 0);
        return true;
    } catch (e) {
        // EPERM：进程存在但无权限发信号 —— 仍算存活
        return e.code !== 'ESRCH';
    }
}

/**
 * 尝试获取归档锁。
 * @param {string} dir 锁文件所在目录（通常是 state/）
 * @param {object} [opts] 注入点：pid / now() / isPidAlive(pid) / staleMs
 * @returns {{ok: true, lockFile: string} | {ok: false, reason: string, holder?: object}}
 */
function acquireLock(dir, opts = {}) {
    const pid = opts.pid ?? process.pid;
    const now = opts.now ?? Date.now;
    const isPidAlive = opts.isPidAlive ?? defaultIsPidAlive;
    const staleMs = opts.staleMs ?? STALE_MS;
    const lockFile = path.join(dir, LOCK_NAME);

    fs.mkdirSync(dir, { recursive: true });
    const payload = JSON.stringify({ pid, startedAt: now() });

    for (let attempt = 0; attempt < 2; attempt++) {
        try {
            fs.writeFileSync(lockFile, payload, { flag: 'wx' });
            return { ok: true, lockFile };
        } catch (e) {
            if (e.code !== 'EEXIST') throw e;
        }

        // 锁已存在：读出持有者判断是否陈旧
        let holder = null;
        try {
            holder = JSON.parse(fs.readFileSync(lockFile, 'utf-8'));
        } catch {
            // 半截/损坏的锁文件视为陈旧
        }
        const stale =
            !holder ||
            typeof holder.pid !== 'number' ||
            !isPidAlive(holder.pid) ||
            !(typeof holder.startedAt === 'number' && now() - holder.startedAt < staleMs);
        if (!stale) {
            return { ok: false, reason: `归档器已在运行 (pid ${holder.pid})`, holder };
        }
        // 陈旧锁：删掉后回到独占创建重试一次（避免与其它接管者竞态时双赢）
        try {
            fs.unlinkSync(lockFile);
        } catch (e) {
            if (e.code !== 'ENOENT') throw e;
        }
    }
    return { ok: false, reason: '获取锁时持续冲突，放弃' };
}

/**
 * 只读检查锁是否被存活进程持有（不接管、不写盘）。
 * viewer 的 /api/sync 用它在 spawn 前拒绝并发；真正的互斥仍由归档器自己
 * acquireLock 保证 —— 这里只是提前给前端一个明确的 409。
 */
function isLocked(dir, opts = {}) {
    const now = opts.now ?? Date.now;
    const isPidAlive = opts.isPidAlive ?? defaultIsPidAlive;
    const staleMs = opts.staleMs ?? STALE_MS;
    let holder;
    try {
        holder = JSON.parse(fs.readFileSync(path.join(dir, LOCK_NAME), 'utf-8'));
    } catch {
        return false;
    }
    return (
        typeof holder.pid === 'number' &&
        isPidAlive(holder.pid) &&
        typeof holder.startedAt === 'number' &&
        now() - holder.startedAt < staleMs
    );
}

/**
 * 释放归档锁。只删除属于自己 pid 的锁，避免误删接管者的新锁。
 */
function releaseLock(dir, opts = {}) {
    const pid = opts.pid ?? process.pid;
    const lockFile = path.join(dir, LOCK_NAME);
    try {
        const holder = JSON.parse(fs.readFileSync(lockFile, 'utf-8'));
        if (holder.pid !== pid) return false;
    } catch {
        return false;
    }
    try {
        fs.unlinkSync(lockFile);
        return true;
    } catch {
        return false;
    }
}

module.exports = { acquireLock, releaseLock, isLocked, LOCK_NAME, STALE_MS };
