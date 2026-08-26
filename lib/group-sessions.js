// 应用内选群（#18）：登录后从 webim 拉会话列表，替代手工编辑 config.json。
//
// 归档器解析群会话靠的是 webim 聊天页左侧会话栏（点击群名即在那个列表里找
// 文本）。这里把同一能力搬到 HTTP 侧（与 live-sync / weibo-auth 同族接口，
// 带 Cookie 即可），不需要浏览器。
//
// 接口是 `/webim/2/direct_messages/contacts.json?special_source=3` —— 前端
// bundle 里唯一真实存在的会话列表接口。曾用过 `/webim/query_sessions.json`，
// 那个路径根本不存在，实测恒回 `20099 [/query_sessions.json] is not allow to
// access!`，于是选群面板永远是空的、只能退回手编 config.json。
//
// 返回的群 id 与归档器写进 state 的 `groupId` 逐个一致（三个已归档群实测
// 全等），所以它也是"不开浏览器就拿到会话 id"的唯一途径。
//
// 响应结构：{ contacts: [{ unread_count, message, user: { id, name, type, … } }] }
// 判群靠 user.type === 2（单聊条目没有 type/group_type）。解析器同时容忍几种
// 历史/文档形态（sessions 平铺、内嵌 group 对象），解析不出任何群时返回空数组
// —— UI 提示失败并指向手编 config.json 的老路。
'use strict';

const { UNAUTHENTICATED_CODE } = require('./weibo-auth');

const API_ORIGIN = 'https://api.weibo.com';
const SESSIONS_PATH = '/webim/2/direct_messages/contacts.json'
    + '?special_source=3&source=209678993';

/**
 * 单个会话条目 → 群描述（非群/残缺条目返回 null）。
 *
 * 判群必须是**肯定式**的：这个列表里单聊远多于群（实测 20 条里 11 个群），
 * 任何"有嵌套对象就算群"之类的宽松判据都会把单聊混进选群面板 —— 用户勾了
 * 之后归档器永远找不到那个"群"，失败又长得像成功。
 */
function normalizeSession(entry) {
    if (!entry || typeof entry !== 'object') return null;

    let g = null;
    if (entry.user && typeof entry.user === 'object') {
        // 真实接口形态：群与单聊都在 user 下，webim 用数值 type=2 标群
        if (entry.user.type !== 2) return null;
        g = entry.user;
    } else if (entry.group && typeof entry.group === 'object') {
        g = entry.group;                       // 文档形态 A：内嵌 group 对象
    } else if (entry.type === 'group' || entry.is_group === true || entry.is_group === 1
        || typeof entry.member_count === 'number') {
        g = entry;                             // 文档形态 B：平铺 + 显式标记
    }
    if (!g) return null;

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
    const list = Array.isArray(json?.contacts) ? json.contacts
        : Array.isArray(json?.sessions) ? json.sessions
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
