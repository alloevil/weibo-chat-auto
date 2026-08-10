// 图片缓存的容量治理。
//
// cache/images 是纯优化：内容都能再从微博 CDN 取回（本地代理只为绕过防盗链），
// 所以可以放心淘汰。此前完全没有淘汰策略，实测涨到 1129 个文件 / 688MB，
// 其中还混着 75MB、49MB 的条目 —— 代理把任何响应都按 `${fid}.jpg` 落盘，
// 视频也被当图片缓存了。
//
// 判定逻辑（planEviction）是纯函数，便于测试；落地（evictCache）只在缓存目录
// 里按预期文件名删除，不递归、不跟随符号链接。
'use strict';

const fs = require('fs');
const path = require('path');

const DEFAULT_MAX_BYTES = 300 * 1024 * 1024;      // 缓存总量上限
const DEFAULT_MAX_AGE_MS = 90 * 24 * 3600 * 1000; // 超过这个年龄一律淘汰
const MAX_ENTRY_BYTES = 8 * 1024 * 1024;          // 单条目上限（超过不写缓存）

/** 读取缓存目录的条目清单（不递归）。 */
function listEntries(dir) {
    let names;
    try {
        names = fs.readdirSync(dir);
    } catch {
        return [];   // 目录还不存在
    }
    const out = [];
    for (const name of names) {
        let st;
        try {
            st = fs.lstatSync(path.join(dir, name));
        } catch {
            continue;   // 竞态删除
        }
        if (!st.isFile()) continue;   // 目录与符号链接一律不动
        out.push({ name, size: st.size, mtime: st.mtimeMs });
    }
    return out;
}

/**
 * 决定要删哪些条目。纯函数。
 * 先按年龄淘汰，再按"最久未使用"（mtime 最老优先）压到容量以内。
 * @returns {{names: string[], freedBytes: number, remainingBytes: number}}
 */
function planEviction(entries, { maxBytes = DEFAULT_MAX_BYTES, maxAgeMs = DEFAULT_MAX_AGE_MS, now = Date.now() } = {}) {
    const sorted = [...entries].sort((a, b) => a.mtime - b.mtime);   // 最老在前
    const doomed = [];
    let total = sorted.reduce((sum, e) => sum + e.size, 0);

    for (const e of sorted) {
        if (maxAgeMs > 0 && now - e.mtime > maxAgeMs) {
            doomed.push(e);
            total -= e.size;
        }
    }
    const agedOut = new Set(doomed.map(e => e.name));
    for (const e of sorted) {
        if (total <= maxBytes) break;
        if (agedOut.has(e.name)) continue;
        doomed.push(e);
        total -= e.size;
    }

    return {
        names: doomed.map(e => e.name),
        freedBytes: doomed.reduce((sum, e) => sum + e.size, 0),
        remainingBytes: total,
    };
}

/**
 * 执行淘汰。
 * @returns {{deleted: number, freedBytes: number, remainingBytes: number}}
 */
function evictCache(dir, opts = {}) {
    const plan = planEviction(listEntries(dir), opts);
    let deleted = 0;
    let freedBytes = 0;
    for (const name of plan.names) {
        try {
            const p = path.join(dir, name);
            const size = fs.statSync(p).size;
            fs.unlinkSync(p);
            deleted++;
            freedBytes += size;
        } catch { /* 已被别的进程删掉，忽略 */ }
    }
    return { deleted, freedBytes, remainingBytes: plan.remainingBytes };
}

/** 该响应是否值得写入缓存（超大条目多半不是图片，写了只是白占空间）。 */
function isCacheable(byteLength, limit = MAX_ENTRY_BYTES) {
    return Number.isFinite(byteLength) && byteLength > 0 && byteLength <= limit;
}

module.exports = {
    listEntries, planEviction, evictCache, isCacheable,
    DEFAULT_MAX_BYTES, DEFAULT_MAX_AGE_MS, MAX_ENTRY_BYTES,
};
