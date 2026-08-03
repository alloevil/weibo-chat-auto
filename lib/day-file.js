// 归档日文件（output/<群>/weibo_chat_YYYY-MM-DD.json）的写入侧不变量。
// 读侧在 lib/load-messages.js。两侧共用同一套日期语义，跨 UTC 日界不会错位。
//
// 归档器有三条消息来源（Node 分页 / 页内脚本 hook / Puppeteer 网络层），
// v1.10.x 之前各自拼 time/date：网络层用 toLocaleString 无零填充（'2026/7/3'）
// 且 date 取 toISOString 的 UTC 切片，于是 viewer 的 time.split(' ')[0] 解析
// 不出日期、跨日界消息被写进前一天。此处是唯一的格式来源。
'use strict';

const fs = require('fs');
const path = require('path');

const p2 = n => String(n).padStart(2, '0');

/** 本地日期 YYYY-MM-DD（日文件名与 msg.date 用它，必须是本地时区）。 */
function formatLocalDate(ts) {
    const d = new Date(ts);
    return `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())}`;
}

/** 本地时间 YYYY/MM/DD HH:mm:ss —— 与既有归档数据逐字符一致，且不依赖 ICU。 */
function formatLocalTime(ts) {
    const d = new Date(ts);
    return `${d.getFullYear()}/${p2(d.getMonth() + 1)}/${p2(d.getDate())} `
        + `${p2(d.getHours())}:${p2(d.getMinutes())}:${p2(d.getSeconds())}`;
}

/**
 * 原子写 JSON：先写同目录临时文件再 rename。
 * 直接 writeFileSync 是截断写，进程被杀/磁盘满会留下半截 JSON，
 * 下一轮读取解析失败即触发整天数据被当"空文件"覆盖。
 */
function writeJsonAtomic(file, value) {
    const tmp = `${file}.tmp-${process.pid}`;
    try {
        fs.writeFileSync(tmp, JSON.stringify(value, null, 2));
        fs.renameSync(tmp, file);
    } catch (e) {
        try { fs.unlinkSync(tmp); } catch {}
        throw e;
    }
}

/**
 * 把本轮消息并入日文件（按 id 去重、按 timestamp 升序、原子落盘）。
 *
 * 解析失败与文件不存在必须区分：前者说明磁盘上有数据但读不出来，
 * 当成空文件会静默覆盖掉整天历史。这里先备份成 .corrupt.<ts> 再重建。
 *
 * @returns {{ existing: number, total: number, corruptBackup: string|null }}
 */
function mergeIntoDayFile(dayFile, newMsgs) {
    let existing = [];
    let corruptBackup = null;

    let raw = null;
    try {
        raw = fs.readFileSync(dayFile, 'utf-8');
    } catch (e) {
        if (e.code !== 'ENOENT') throw e;
    }

    if (raw !== null) {
        try {
            const data = JSON.parse(raw);
            const msgs = Array.isArray(data) ? data : data.messages;
            if (!Array.isArray(msgs)) throw new Error('JSON 中没有消息数组');
            existing = msgs;
        } catch (e) {
            corruptBackup = `${dayFile}.corrupt.${Date.now()}`;
            fs.renameSync(dayFile, corruptBackup);
            console.warn(
                `[day-file] ${path.basename(dayFile)} 解析失败(${e.message})，`
                + `已备份到 ${path.basename(corruptBackup)} 后重建`
            );
        }
    }

    const merged = new Map();
    for (const m of existing) merged.set(String(m.id), m);
    for (const m of newMsgs) merged.set(String(m.id), m);

    const deduped = [...merged.values()].sort((a, b) => a.timestamp - b.timestamp);
    writeJsonAtomic(dayFile, deduped);

    return { existing: existing.length, total: deduped.length, corruptBackup };
}

module.exports = { formatLocalDate, formatLocalTime, writeJsonAtomic, mergeIntoDayFile };
