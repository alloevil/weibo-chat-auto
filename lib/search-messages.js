// 跨日期全量搜索。
//
// 此前搜索只作用于"当前选中的那一天"（getFiltered 先按 date 过滤），而用户在
// 搜索框输入时的自然期待是搜全部历史 —— 16 万条里找一句话，却只搜了当天几百条。
//
// 语义选择：子串命中 + 时间倒序，而不是 BM25 相关性排序。lib/search-bm25 服务
// 的是 AI 问答（要的是"最相关的片段"），而搜索框要的是"我记得有人说过这句话"，
// 精确、可预期、能按时间定位。两者刻意不共用。
'use strict';

const DEFAULT_LIMIT = 60;
const PREVIEW_LEN = 90;

/** 命中处前后各留一点上下文的摘要（让结果列表能看出是哪句话）。 */
function preview(text, needle, len = PREVIEW_LEN) {
    const s = String(text || '').replace(/\s+/g, ' ').trim();
    if (s.length <= len) return s;
    const at = needle ? s.toLowerCase().indexOf(needle) : -1;
    if (at < 0) return s.slice(0, len) + '…';
    const start = Math.max(0, at - Math.floor((len - needle.length) / 2));
    return (start > 0 ? '…' : '') + s.slice(start, start + len) + (start + len < s.length ? '…' : '');
}

/**
 * 在整组消息里搜索。
 * @param {object[]} messages 全量消息（含 date/time/user/content）
 * @param {string} query 查询串（大小写不敏感；同时匹配正文与发送者）
 * @param {{limit?: number, offset?: number}} [opts]
 * @returns {{total: number, byDate: Array<{date: string, count: number}>, hits: object[], truncated: boolean}}
 */
function searchMessages(messages, query, { limit = DEFAULT_LIMIT, offset = 0 } = {}) {
    const q = String(query || '').trim().toLowerCase();
    if (!q) return { total: 0, byDate: [], hits: [], truncated: false };

    const matched = [];
    const dateCount = new Map();
    for (const m of messages) {
        const content = String(m.content || '').toLowerCase();
        const user = String(m.user || '').toLowerCase();
        if (!content.includes(q) && !user.includes(q)) continue;
        matched.push(m);
        dateCount.set(m.date, (dateCount.get(m.date) || 0) + 1);
    }

    // 时间倒序：找"我记得谁说过"时，越近越可能是目标
    matched.sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0));

    const page = matched.slice(offset, offset + limit);
    return {
        total: matched.length,
        // 每天命中数：结果太多时用它快速定位到某一天
        byDate: [...dateCount.entries()].sort((a, b) => (a[0] < b[0] ? 1 : -1)).map(([date, count]) => ({ date, count })),
        hits: page.map(m => ({
            id: String(m.id),
            date: m.date,
            time: m.time,
            user: m.user,
            preview: preview(m.content, q),
        })),
        truncated: matched.length > offset + page.length,
    };
}

module.exports = { searchMessages, preview, DEFAULT_LIMIT };
