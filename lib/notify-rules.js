// 「提到我」判定与通知规则。
//
// 群里一天 800 条，靠肉眼找与自己相关的消息不现实；实时同步开着也完全没有提醒
// （此前代码里一次 Notification 调用都没有）。这里把"哪些消息值得打扰用户"的
// 判定收成纯函数，便于测试，也便于以后改规则时只动一处。
'use strict';

const { isNoise } = require('./text-utils');

/** 转义正则元字符（关键词由用户输入，可能含 . * + 等）。 */
function escapeRe(s) {
    return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * 判断消息是否「提到我」。
 * 匹配两类：
 *   · @昵称（微博原文里就是这个形式，允许后跟标点/空白/结尾）
 *   · 回复引用里出现「@昵称」（引用块也算提到）
 * 刻意不匹配"昵称"裸出现：群名、闲聊里带到名字太常见，会把提醒变成噪声。
 */
function mentionsMe(message, me) {
    const nick = String(me?.screenName || '').trim();
    if (!nick) return false;
    const text = String(message?.content || '');
    if (!text) return false;
    // 后界用"非昵称可延续字符"：@张三丰 不应命中 @张三
    return new RegExp(`@${escapeRe(nick)}(?![\\w一-鿿])`).test(text);
}

/** 是否命中用户订阅的关键词（大小写不敏感，子串即算）。 */
function matchedKeywords(message, keywords) {
    const text = String(message?.content || '').toLowerCase();
    if (!text) return [];
    return (keywords || [])
        .map(k => String(k || '').trim())
        .filter(k => k && text.includes(k.toLowerCase()));
}

/**
 * 一批新消息 → 该弹哪些通知。
 * 规则（按优先级，一条消息只产生一条通知）：
 *   1. 提到我 —— 最该打扰
 *   2. 命中订阅关键词
 *   3. 其余：不逐条弹，只在 notifyAll 打开时汇总一条"N 条新消息"
 * 自己发的消息永不通知。
 *
 * @param {object[]} messages 本轮新消息
 * @param {{screenName?: string, uid?: string}} me
 * @param {{keywords?: string[], notifyAll?: boolean, group?: string}} opts
 * @returns {Array<{kind:'mention'|'keyword'|'digest', title:string, body:string, id?:string, date?:string}>}
 */
function buildNotifications(messages, me, { keywords = [], notifyAll = false, group = '' } = {}) {
    const mine = String(me?.uid || '');
    // 噪声不该打扰人：签到机器人会 @ 每个成员（实测占「提到我」命中的 93%），
    // 红包/问候语同理。判据与 viewer 的「隐藏噪声」共用 lib/text-utils。
    const fromOthers = (messages || []).filter(m => (!mine || String(m.from_uid || '') !== mine) && !isNoise(m));
    if (fromOthers.length === 0) return [];

    const out = [];
    const flagged = new Set();
    for (const m of fromOthers) {
        if (mentionsMe(m, me)) {
            flagged.add(m);
            out.push({
                kind: 'mention',
                title: `${m.user} 在${group ? `「${group}」` : ''}提到你`,
                body: String(m.content || '').slice(0, 120),
                id: String(m.id), date: m.date,
            });
            continue;
        }
        const hits = matchedKeywords(m, keywords);
        if (hits.length) {
            flagged.add(m);
            out.push({
                kind: 'keyword',
                title: `关键词「${hits[0]}」${group ? ` · ${group}` : ''}`,
                body: `${m.user}: ${String(m.content || '').slice(0, 120)}`,
                id: String(m.id), date: m.date,
            });
        }
    }

    const rest = fromOthers.filter(m => !flagged.has(m));
    if (notifyAll && rest.length > 0) {
        out.push({
            kind: 'digest',
            title: group ? `「${group}」${rest.length} 条新消息` : `${rest.length} 条新消息`,
            body: rest.slice(-3).map(m => `${m.user}: ${String(m.content || '').slice(0, 40)}`).join('\n'),
            date: rest[rest.length - 1].date,
        });
    }
    return out;
}

module.exports = { mentionsMe, matchedKeywords, buildNotifications };
