// 归档消息的统一加载入口（viewer-server / eval runner / 索引回填脚本共用）。
// mtime 文件级缓存：只重读有变动的日文件，其余直接用缓存合并。
'use strict';

const fs = require('fs');
const path = require('path');
const { legacyGroupKey, uniqueGroupKey } = require('./group-storage');

const DAY_FILE_RE = /^weibo_chat_(\d{4}-\d{2}-\d{2})\.json$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

// date 会被拼进文件名（此处及 viewer-server 的 summary 缓存），未校验时
// `../../../../cookies` 之类可穿越出 output/ 目录读写任意文件。
function isValidDate(date) {
    return typeof date === 'string' && DATE_RE.test(date);
}

// 少量历史消息的 user 是数字 uid(归档时未解析出昵称)。前端渲染
// (charAt)与检索(toLowerCase)都按字符串处理,读入时统一归一。
function normalizeUsers(msgs) {
    for (const m of msgs) {
        if (m && typeof m.user !== 'string') m.user = String(m.user ?? '');
    }
    return msgs;
}

// 文件缓存避免重复 JSON.parse；目录缓存避免每次全量搜索都重新拼接和排序十几万条消息。
const directoryCaches = {}; // dir -> { signature, messages, dateCounts }
const fileCaches = {}; // filePath -> { signature, messages }

function getGroupDir(outputDir, groupName) {
    if (!groupName) return outputDir;
    const uniqueDir = path.join(outputDir, uniqueGroupKey(groupName));
    if (fs.existsSync(uniqueDir)) return uniqueDir;
    // API 通常直接传 storageKey；该 key 只含旧规则允许的字符，因此这里保持原样。
    return path.join(outputDir, legacyGroupKey(groupName));
}

function scanDayFiles(dir) {
    if (!fs.existsSync(dir)) return [];
    const entries = [];
    for (const name of fs
        .readdirSync(dir)
        .filter((f) => DAY_FILE_RE.test(f))
        .sort()) {
        try {
            const stat = fs.statSync(path.join(dir, name));
            entries.push({ name, mtime: stat.mtimeMs, size: stat.size });
        } catch {
            /* 文件在扫描期间被替换，下次调用会重新发现 */
        }
    }
    return entries;
}

function fileSignature(entry) {
    return `${entry.mtime}:${entry.size}`;
}

function directorySignature(entries) {
    return entries.map((entry) => `${entry.name}:${fileSignature(entry)}`).join('|');
}

function loadDayFile(dir, entry) {
    const filePath = path.join(dir, entry.name);
    const signature = fileSignature(entry);
    if (fileCaches[filePath]?.signature === signature) return fileCaches[filePath].messages;
    let messages = [];
    try {
        const data = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
        const parsed = data.messages || data;
        if (Array.isArray(parsed)) {
            messages = normalizeUsers(parsed);
            messages.sort((a, b) => a.timestamp - b.timestamp);
        }
    } catch {
        /* 损坏文件按空文件处理；mtime/大小变化后会自动重试 */
    }
    fileCaches[filePath] = { signature, messages };
    return messages;
}

function buildDirectoryCache(dir) {
    const entries = scanDayFiles(dir);
    const signature = directorySignature(entries);
    if (directoryCaches[dir]?.signature === signature) return directoryCaches[dir];

    const messages = [];
    const dateCounts = {};
    for (const entry of entries) {
        const dayMessages = loadDayFile(dir, entry);
        messages.push(...dayMessages);
        dateCounts[entry.name.match(DAY_FILE_RE)[1]] = dayMessages.length;
    }
    // 历史文件通常已按日期和时间有序，但脏数据可能跨日，重建缓存时统一校正一次。
    messages.sort((a, b) => a.timestamp - b.timestamp);
    const cache = { signature, messages, dateCounts };
    directoryCaches[dir] = cache;
    return cache;
}

/** 加载某群全部消息（timestamp 升序）。目录不存在返回 []。 */
function loadMessages(outputDir, groupName = '') {
    const dir = getGroupDir(outputDir, groupName);
    if (!fs.existsSync(dir)) return [];
    return buildDirectoryCache(dir).messages;
}

/** 加载某群某天的消息（timestamp 升序）。文件不存在返回 []。 */
function loadMessagesByDate(outputDir, groupName = '', date = '') {
    if (!isValidDate(date)) return [];
    const dir = getGroupDir(outputDir, groupName);
    if (!fs.existsSync(dir)) return [];

    try {
        const name = `weibo_chat_${date}.json`;
        const stat = fs.statSync(path.join(dir, name));
        return loadDayFile(dir, { name, mtime: stat.mtimeMs, size: stat.size });
    } catch {
        return [];
    }
}

/** 某群有归档数据的日期列表（升序）。 */
function listDates(outputDir, groupName = '') {
    const dir = getGroupDir(outputDir, groupName);
    return scanDayFiles(dir).map((entry) => entry.name.match(DAY_FILE_RE)[1]);
}

/** 日期 → 消息数；复用目录缓存，不重复解析全部日文件。 */
function listDateCounts(outputDir, groupName = '') {
    const dir = getGroupDir(outputDir, groupName);
    if (!fs.existsSync(dir)) return {};
    return { ...buildDirectoryCache(dir).dateCounts };
}

/** 清空所有缓存（手动刷新数据时用）。 */
function clearCaches() {
    for (const key in directoryCaches) delete directoryCaches[key];
    for (const key in fileCaches) delete fileCaches[key];
}

module.exports = {
    getGroupDir,
    isValidDate,
    loadMessages,
    loadMessagesByDate,
    listDates,
    listDateCounts,
    clearCaches,
};
