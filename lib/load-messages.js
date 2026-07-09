// 归档消息的统一加载入口（viewer-server / eval runner / 索引回填脚本共用）。
// mtime 文件级缓存：只重读有变动的日文件，其余直接用缓存合并。
'use strict';

const fs = require('fs');
const path = require('path');

const DAY_FILE_RE = /^weibo_chat_(\d{4}-\d{2}-\d{2})\.json$/;

// 缓存以 dir 为键（同一 outputDir + group 恒定映射到同一 dir）
const messageCaches = {}; // dir -> { filename -> { mtime, messages } }
const fileCaches = {};    // filePath -> { mtime, messages }

function getGroupDir(outputDir, groupName) {
    if (!groupName) return outputDir;
    const safe = groupName.replace(/[^a-zA-Z0-9一-鿿]/g, '_');
    return path.join(outputDir, safe);
}

/** 加载某群全部消息（timestamp 升序）。目录不存在返回 []。 */
function loadMessages(outputDir, groupName = '') {
    const dir = getGroupDir(outputDir, groupName);
    if (!fs.existsSync(dir)) return [];

    if (!messageCaches[dir]) messageCaches[dir] = {};
    const cache = messageCaches[dir];

    const files = fs.readdirSync(dir).filter(f => DAY_FILE_RE.test(f));

    let changed = false;
    const currentMtimes = {};
    for (const f of files) {
        const mt = fs.statSync(path.join(dir, f)).mtimeMs;
        currentMtimes[f] = mt;
        if (!cache[f] || cache[f].mtime !== mt) changed = true;
    }
    if (!changed && Object.keys(cache).length === files.length) {
        const all = [];
        for (const f of files) all.push(...cache[f].messages);
        all.sort((a, b) => a.timestamp - b.timestamp);
        return all;
    }

    const allMessages = [];
    for (const file of files) {
        const mt = currentMtimes[file];
        if (cache[file] && cache[file].mtime === mt) {
            allMessages.push(...cache[file].messages);
        } else {
            try {
                const data = JSON.parse(fs.readFileSync(path.join(dir, file), 'utf-8'));
                const msgs = data.messages || data;
                if (Array.isArray(msgs)) {
                    cache[file] = { mtime: mt, messages: msgs };
                    allMessages.push(...msgs);
                }
            } catch { /* 损坏文件跳过 */ }
        }
    }

    allMessages.sort((a, b) => a.timestamp - b.timestamp);
    return allMessages;
}

/** 加载某群某天的消息（timestamp 升序）。文件不存在返回 []。 */
function loadMessagesByDate(outputDir, groupName = '', date = '') {
    const dir = getGroupDir(outputDir, groupName);
    if (!fs.existsSync(dir)) return [];

    const filePath = path.join(dir, `weibo_chat_${date}.json`);
    if (!fs.existsSync(filePath)) return [];

    try {
        const mt = fs.statSync(filePath).mtimeMs;
        if (fileCaches[filePath] && fileCaches[filePath].mtime === mt) {
            return fileCaches[filePath].messages;
        }
        const data = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
        const msgs = data.messages || data;
        if (!Array.isArray(msgs)) return [];
        msgs.sort((a, b) => a.timestamp - b.timestamp);
        fileCaches[filePath] = { mtime: mt, messages: msgs };
        return msgs;
    } catch {
        return [];
    }
}

/** 某群有归档数据的日期列表（升序）。 */
function listDates(outputDir, groupName = '') {
    const dir = getGroupDir(outputDir, groupName);
    if (!fs.existsSync(dir)) return [];
    return fs.readdirSync(dir)
        .map(f => f.match(DAY_FILE_RE))
        .filter(Boolean)
        .map(m => m[1])
        .sort();
}

/** 清空所有缓存（手动刷新数据时用）。 */
function clearCaches() {
    for (const key in messageCaches) delete messageCaches[key];
    for (const key in fileCaches) delete fileCaches[key];
}

module.exports = { getGroupDir, loadMessages, loadMessagesByDate, listDates, clearCaches };
