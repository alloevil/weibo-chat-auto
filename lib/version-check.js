// 版本检查(#17):当前版本来自 package.json(与 tauri.conf.json 同步维护),
// 最新版本读 GitHub releases API。全链路静默失败——检查更新永远不该打扰用户。
// 纯逻辑(比较/解析/缓存)在此,网络请求由调用方注入,便于单测。
const CURRENT_VERSION = require('../package.json').version;

const RELEASES_LATEST_API = 'https://api.github.com/repos/alloevil/weibo-chat-auto/releases/latest';
const RELEASES_LATEST_URL = 'https://github.com/alloevil/weibo-chat-auto/releases/latest';

/** "v1.23.0" / "1.23.0" → [1,23,0];无法解析返回 null(异常 tag 不比较、不提示)。 */
function parseVersion(tag) {
    const m = /^v?(\d+)\.(\d+)\.(\d+)/.exec(String(tag || '').trim());
    if (!m) return null;
    return [Number(m[1]), Number(m[2]), Number(m[3])];
}

/** latest 是否严格新于 current。任一侧解析失败 → false(宁可漏提示,不可误报)。 */
function isNewer(latest, current) {
    const a = parseVersion(latest);
    const b = parseVersion(current);
    if (!a || !b) return false;
    for (let i = 0; i < 3; i++) {
        if (a[i] !== b[i]) return a[i] > b[i];
    }
    return false;
}

/** GitHub /releases/latest 响应体 → { tag, url };结构不符返回 null。 */
function extractLatest(json) {
    if (!json || typeof json.tag_name !== 'string' || !json.tag_name) return null;
    return {
        tag: json.tag_name,
        url: typeof json.html_url === 'string' && json.html_url ? json.html_url : RELEASES_LATEST_URL,
    };
}

const DEFAULT_TTL_MS = 6 * 60 * 60 * 1000; // 6 小时:更新提示不需要实时

/**
 * 带缓存的检查器。fetchLatest 为注入的异步函数(返回 GitHub API 的 JSON 对象,
 * 失败可 throw 或返回 null)。同一 TTL 窗口内只发一次请求;失败也记入缓存
 * (避免离线时每次开设置都重试网络)。
 */
function createVersionChecker({ fetchLatest, now = Date.now, ttlMs = DEFAULT_TTL_MS, currentVersion = CURRENT_VERSION } = {}) {
    let cache = null; // { at, result }
    let inflight = null;

    async function doFetch() {
        let latest = null;
        try {
            latest = extractLatest(await fetchLatest());
        } catch {
            latest = null; // 静默:网络失败/限流/解析失败都等同「无更新信息」
        }
        const result = {
            ok: true,
            version: currentVersion,
            latestTag: latest ? latest.tag : null,
            updateAvailable: latest ? isNewer(latest.tag, currentVersion) : false,
            url: latest ? latest.url : RELEASES_LATEST_URL,
        };
        cache = { at: now(), result };
        return result;
    }

    return {
        async check() {
            if (cache && now() - cache.at < ttlMs) return cache.result;
            // 并发去重:同窗口多个请求共享一次网络往返
            if (!inflight) {
                inflight = doFetch().finally(() => { inflight = null; });
            }
            return inflight;
        },
    };
}

module.exports = {
    CURRENT_VERSION,
    RELEASES_LATEST_API,
    RELEASES_LATEST_URL,
    parseVersion,
    isNewer,
    extractLatest,
    createVersionChecker,
};
