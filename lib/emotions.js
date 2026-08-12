// 微博官方表情清单（/webim/emotions.json）→ 标签到图片 URL 的映射。
//
// 为什么需要它：内置的 Unicode 映射表只有 101 条，而真实归档里出现过 444 种
// 表情标签 —— 实测 16.7% 的标签渲染不出来，只能显示成 [卡皮巴拉] 这样的文字。
// 手工维护追不上微博加新表情，官方清单是唯一权威来源（340 条，可救回 59%）。
//
// 清单几乎不变，因此磁盘缓存 7 天；拉取失败时**继续用旧缓存**，绝不因为一次
// 网络抖动就让整屏表情退回文字。
'use strict';

const fs = require('fs');
const path = require('path');

const SOURCE_URL = 'https://api.weibo.com/webim/emotions.json?source=209678993';
const TTL_MS = 7 * 24 * 3600 * 1000;

/** 把官方清单压成 { '[标签]': 'url' }（只保留能渲染的条目）。 */
function toPhraseMap(list) {
    const map = {};
    if (!Array.isArray(list)) return map;
    for (const e of list) {
        const phrase = e && (e.phrase || e.value);
        const url = e && (e.url || e.icon);
        if (typeof phrase === 'string' && /^\[.+\]$/.test(phrase) && typeof url === 'string' && /^https?:\/\//.test(url)) {
            map[phrase] = url;
        }
    }
    return map;
}

/**
 * 取表情映射：缓存新鲜就用缓存，过期则拉取并回写；拉取失败退回旧缓存。
 * @returns {Promise<{map: object, source: 'cache'|'network'|'stale'|'empty', count: number}>}
 */
async function loadEmotions(cacheFile, { fetchImpl = fetch, now = Date.now(), ttlMs = TTL_MS, cookieHeader = '' } = {}) {
    let cached = null;
    try {
        cached = JSON.parse(fs.readFileSync(cacheFile, 'utf-8'));
    } catch { /* 无缓存或损坏 */ }

    const fresh = cached && Number.isFinite(cached.fetchedAt) && (now - cached.fetchedAt) < ttlMs;
    if (fresh && cached.map && Object.keys(cached.map).length > 0) {
        return { map: cached.map, source: 'cache', count: Object.keys(cached.map).length };
    }

    try {
        const resp = await fetchImpl(SOURCE_URL, {
            headers: {
                Cookie: cookieHeader,
                Referer: 'https://api.weibo.com/chat',
                'X-Requested-With': 'XMLHttpRequest',
            },
            signal: AbortSignal.timeout(10000),
        });
        const map = toPhraseMap(await resp.json());
        if (Object.keys(map).length === 0) throw new Error('清单为空');
        try {
            fs.mkdirSync(path.dirname(cacheFile), { recursive: true });
            fs.writeFileSync(cacheFile, JSON.stringify({ fetchedAt: now, map }, null, 0));
        } catch { /* 缓存写不进去不影响本次使用 */ }
        return { map, source: 'network', count: Object.keys(map).length };
    } catch {
        // 网络失败：宁可用过期清单，也不要让表情整屏退回文字
        if (cached && cached.map) {
            return { map: cached.map, source: 'stale', count: Object.keys(cached.map).length };
        }
        return { map: {}, source: 'empty', count: 0 };
    }
}

module.exports = { loadEmotions, toPhraseMap, SOURCE_URL, TTL_MS };
