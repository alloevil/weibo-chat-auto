// 话题块索引的加载与降级:读取 qa-index/chunks_<date>.json(离线 LLM 标注),
// 用 sourceMtime/sourceCount 与当前日文件比对判定新鲜度;索引缺失或过期
// 时降级为即时切块(无标注)。QA 对索引无硬依赖。
'use strict';

const fs = require('fs');
const path = require('path');
const { splitIntoChunks } = require('./chat-chunks');

const INDEX_DIR = 'qa-index';

function indexPathFor(groupDir, date) {
    return path.join(groupDir, INDEX_DIR, `chunks_${date}.json`);
}

function dayFilePathFor(groupDir, date) {
    return path.join(groupDir, `weibo_chat_${date}.json`);
}

// mtime 缓存:indexPath -> { mtime, data }
const indexCache = {};

/**
 * 加载某群的话题块索引。
 * @param {string} groupDir output/<group> 目录
 * @param {string[]} dates 需要的日期列表
 * @returns {{ byDate: Map<string, object|null>, staleDates: string[] }}
 *   byDate 值为索引文件内容;null 表示无可用索引(缺失/过期/损坏)
 */
function loadChunkIndex(groupDir, dates) {
    const byDate = new Map();
    const staleDates = [];
    for (const date of dates) {
        const idxPath = indexPathFor(groupDir, date);
        const dayPath = dayFilePathFor(groupDir, date);
        let entry = null;
        try {
            const idxStat = fs.statSync(idxPath);
            let data;
            if (indexCache[idxPath] && indexCache[idxPath].mtime === idxStat.mtimeMs) {
                data = indexCache[idxPath].data;
            } else {
                data = JSON.parse(fs.readFileSync(idxPath, 'utf-8'));
                indexCache[idxPath] = { mtime: idxStat.mtimeMs, data };
            }
            // 新鲜度:源文件 mtime 和消息数都必须一致,否则视为过期
            const dayStat = fs.statSync(dayPath);
            if (data && data.sourceMtime === dayStat.mtimeMs) {
                entry = data;
            }
        } catch { /* 索引缺失/损坏 → 降级 */ }
        if (!entry) staleDates.push(date);
        byDate.set(date, entry);
    }
    return { byDate, staleDates };
}

/** 即时切块(降级路径,无标注)。输入需按 timestamp 升序。 */
function buildChunksForMessages(messages, opts) {
    return splitIntoChunks(messages, opts).map(c => ({ ...c, annotation: null }));
}

function clearIndexCache() {
    for (const k in indexCache) delete indexCache[k];
}

module.exports = { loadChunkIndex, buildChunksForMessages, indexPathFor, dayFilePathFor, INDEX_DIR, clearIndexCache };
