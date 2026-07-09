// 话题块切分:把按时间排序的消息流切成"话题块",作为检索单元。
//
// 背景:单条群聊消息只有十几个字,BM25 对超短文档打分不稳;群聊的语义
// 单位是话题串。切分规则:
//   1. 相邻消息间隔 > gapMs(默认 30 分钟)视为话题切换,断开;
//   2. 超过 maxMsgs 的长块在其内部最大时间间隔处对半切,递归直到达标
//      (实测纯 30 分钟断层太粗:活跃日 820 条只切出 6 块)。
// 切分是确定性的:同输入必得同输出(chunkKey 依赖此性质做标注复用)。
'use strict';

const crypto = require('crypto');

/**
 * @param {Array<{id, timestamp, user}>} messages 必须已按 timestamp 升序
 * @returns {Array<{seq, msgIds, startTs, endTs, users, date}>}
 */
function splitIntoChunks(messages, { gapMs = 30 * 60 * 1000, maxMsgs = 50 } = {}) {
    if (!messages.length) return [];

    // 第一刀:时间断层
    const groups = [];
    let cur = [messages[0]];
    for (let i = 1; i < messages.length; i++) {
        const prev = messages[i - 1], m = messages[i];
        if (m.timestamp && prev.timestamp && m.timestamp - prev.timestamp > gapMs) {
            groups.push(cur);
            cur = [m];
        } else {
            cur.push(m);
        }
    }
    groups.push(cur);

    // 第二刀:长块在内部最大间隔处对半切
    const result = [];
    const splitLong = (group) => {
        if (group.length <= maxMsgs) {
            result.push(group);
            return;
        }
        // 在中间 60% 区域找最大间隔(避免切在边上产生碎块)
        const lo = Math.max(1, Math.floor(group.length * 0.2));
        const hi = Math.min(group.length - 1, Math.ceil(group.length * 0.8));
        let cutAt = Math.floor(group.length / 2), maxGap = -1;
        for (let i = lo; i < hi; i++) {
            const gap = (group[i].timestamp || 0) - (group[i - 1].timestamp || 0);
            if (gap > maxGap) { maxGap = gap; cutAt = i; }
        }
        splitLong(group.slice(0, cutAt));
        splitLong(group.slice(cutAt));
    };
    for (const g of groups) splitLong(g);

    return result.map((msgs, seq) => ({
        seq,
        msgIds: msgs.map(m => m.id),
        startTs: msgs[0].timestamp || 0,
        endTs: msgs[msgs.length - 1].timestamp || 0,
        users: [...new Set(msgs.map(m => String(m.user ?? '')))],
        date: (msgs[0].time || '').split(' ')[0].replace(/\//g, '-'),
    }));
}

/** 块身份指纹(由成员消息 id 决定)。id 集合不变 → 标注可复用。 */
function chunkKey(chunk) {
    return crypto.createHash('sha1').update(chunk.msgIds.join(',')).digest('hex').slice(0, 12);
}

module.exports = { splitIntoChunks, chunkKey };
