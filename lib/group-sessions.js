// 应用内选群（#18）：登录后从 webim 拉会话列表，替代手工编辑 config.json。
//
// 归档器解析群会话靠的就是 webim 聊天页 —— 它左侧会话栏由
// query_sessions.json 渲染（点击群名即在这个列表里找文本）。这里把同一
// 能力搬到 HTTP 侧（与 live-sync / weibo-auth 同族接口，带 Cookie 即可），
// 不需要浏览器。
//
// 接口响应结构历史上有过漂移，解析器对几种已知形态都容忍：
//   A. { sessions: [{ type:'group', group:{ id,name,avatar } }] }
//   B. { sessions: [{ id, name, avatar, type }] }
//   C. { data: { sessions: [...] } }
// 解析不出任何群时返回空数组 —— UI 提示失败并指向手编 config.json 的老路。
'use strict';

const { UNAUTHENTICATED_CODE } = require('./weibo-auth');

const API_ORIGIN = 'https://api.weibo.com';
const SESSIONS_PATH = '/webim/query_sessions.json'
    + '?is_include_group=1&additional_info=1&count=500&source=209678993';

/** 单个会话条目 → 群描述（非群/残缺条目返回 null）。 */
function normalizeSession(entry) {
    if (!entry || typeof entry !== 'object') return null;
    // 群信息可能内嵌在 group 字段，也可能平铺在条目上
    const g = (entry.group && typeof entry.group === 'object') ? entry.group : entry;
    // 判群：显式 type/is_group 标记，或存在内嵌 group 对象
    const isGroup = entry.type === 'group' || g !== entry
        || entry.is_group === true || entry.is_group === 1
        || typeof g.member_count === 'number';
    if (!isGroup) return null;
    const id = g.id ?? g.gid;
    const name = g.name ?? g.group_name ?? g.screen_name;
    if (id === undefined || id === null || String(id) === '0' || !name) return null;
    return {
        id: String(id),
        name: String(name),
        avatar: String(g.avatar || g.profile_image_url || g.avatar_large || ''),
        memberCount: typeof g.member_count === 'number' ? g.member_count : null,
    };
}

/** 响应 JSON → 群列表（按名称去重，保序）。 */
function parseGroupSessions(json) {
    const list = Array.isArray(json?.sessions) ? json.sessions
        : Array.isArray(json?.data?.sessions) ? json.data.sessions
        : Array.isArray(json?.data) ? json.data
        : [];
    const out = [];
    const seen = new Set();
    for (const entry of list) {
        const g = normalizeSession(entry);
        if (g && !seen.has(g.name)) {
            seen.add(g.name);
            out.push(g);
        }
    }
    return out;
}

/**
 * 拉取群会话列表。
 * @returns {Promise<{ok:true, groups:object[]} | {ok:false, error:string, unauthenticated?:boolean}>}
 */
async function fetchGroupSessions({ cookieHeader, fetchImpl = fetch, timeoutMs = 15000 } = {}) {
    let data;
    try {
        const resp = await fetchImpl(API_ORIGIN + SESSIONS_PATH, {
            headers: {
                Cookie: cookieHeader,
                Referer: API_ORIGIN + '/chat',
                'X-Requested-With': 'XMLHttpRequest',
            },
            signal: AbortSignal.timeout(timeoutMs),
        });
        data = await resp.json();
    } catch (e) {
        return { ok: false, error: `会话列表请求失败: ${e.message}` };
    }
    if (data?.error_code === UNAUTHENTICATED_CODE) {
        return { ok: false, error: '微博登录已失效，请重新扫码', unauthenticated: true };
    }
    if (data?.error_code) {
        return { ok: false, error: `接口错误 ${data.error_code}: ${data.error || ''}` };
    }
    const groups = parseGroupSessions(data);
    if (!groups.length) {
        return { ok: false, error: '未解析出任何群会话（接口结构可能已变化，可继续手工编辑 config.json）' };
    }
    return { ok: true, groups };
}

/**
 * 已配置群名与会话列表的比对：UI 用它把「群名不匹配」变成明确错误，
 * 而不是归档器日志里一行 group not found。
 */
function diffConfiguredGroups(configured, sessions) {
    const names = new Set((sessions || []).map(s => s.name));
    const matched = [];
    const missing = [];
    for (const name of configured || []) {
        (names.has(name) ? matched : missing).push(name);
    }
    return { matched, missing };
}

module.exports = { fetchGroupSessions, parseGroupSessions, normalizeSession, diffConfiguredGroups, SESSIONS_PATH };
