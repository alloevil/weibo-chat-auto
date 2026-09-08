// 发言人别名解析：把「tk」这类口语称呼映射到归档里的真实 user 名。
//
// 背景：检索里 person 过滤和 BM25 都只认归档中的 user 字段原文。群聊里没人
// 用全名称呼彼此（tombkeeper → tk），于是问「tk 最近说了什么」时：person
// 过滤匹配不到 → 退回全量搜索，关键词「tk」在正文里也几乎不出现 → 零命中。
// 历史 benchmark 第一行「Agent 搜 "tk"+"tombkeeper"」就是模型在替这个缺口
// 打补丁：多花一轮 LLM 往返去猜别名。一张映射表就能省掉那轮试探。
//
// 表放在 output/<group>/aliases.json（与 qa-index/ 同级，跟群走）：
//   { "tombkeeper": ["tk", "TK"], "张三丰": ["三丰", "老张"] }
// 键是归档里的真实 user 名，值是别名列表。缺失/损坏 → 空表，检索行为不变。
//
// 另外内置一条无需配置的规则：user 名本身的前缀/子串匹配（见 resolvePerson），
// 覆盖「胡锡进」→「胡锡」这类不必手写的情况。
'use strict';

const fs = require('fs');
const path = require('path');

const ALIAS_FILE = 'aliases.json';

// mtime 缓存：检索是热路径，每次问答会调多次（count_messages + search_messages）
const cache = {}; // filePath -> { mtime, table }

function aliasPathFor(groupDir) {
    return path.join(groupDir, ALIAS_FILE);
}

/**
 * 读取别名表，归一为 alias(小写) -> canonical user 名。
 * @returns {Map<string,string>} 缺失/损坏时为空 Map
 */
function loadAliases(groupDir) {
    if (!groupDir) return new Map();
    const file = aliasPathFor(groupDir);
    let stat;
    try {
        stat = fs.statSync(file);
    } catch {
        return new Map();
    }
    const hit = cache[file];
    if (hit && hit.mtime === stat.mtimeMs) return hit.table;

    const table = new Map();
    try {
        const raw = JSON.parse(fs.readFileSync(file, 'utf-8'));
        if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
            for (const [canonical, aliases] of Object.entries(raw)) {
                const name = String(canonical ?? '').trim();
                if (!name) continue;
                // 真名自身也算一个别名，省掉调用方的特判
                table.set(name.toLowerCase(), name);
                for (const a of Array.isArray(aliases) ? aliases : [aliases]) {
                    const key = String(a ?? '')
                        .trim()
                        .toLowerCase();
                    // 已存在的别名不覆盖：先声明者优先，避免表里写重时行为随
                    // Object.entries 顺序漂移
                    if (key && !table.has(key)) table.set(key, name);
                }
            }
        }
    } catch {
        /* 损坏 → 空表降级 */
    }
    cache[file] = { mtime: stat.mtimeMs, table };
    return table;
}

/**
 * 把用户/模型给的 person 解析成归档里实际存在的 user 名列表。
 *
 * 三级匹配，逐级放宽（前一级有结果就不再放宽，避免「张三」把「张三丰」也带出来）：
 *   1. 别名表精确命中
 *   2. user 名精确相等（大小写不敏感）
 *   3. 子串包含 —— 与既有 person 过滤的行为一致，保持兼容
 *
 * @param {string} person 待解析的称呼
 * @param {Iterable<string>} knownUsers 归档里出现过的 user 名
 * @param {Map<string,string>} aliases loadAliases() 的结果
 * @returns {string[]} 匹配到的真实 user 名（去重保序）；无匹配返回 []
 */
function resolvePerson(person, knownUsers, aliases = new Map()) {
    const q = String(person ?? '')
        .trim()
        .toLowerCase();
    if (!q) return [];
    const users = [...new Set([...knownUsers].map((u) => String(u ?? '')).filter(Boolean))];

    const canonical = aliases.get(q);
    if (canonical) {
        // 别名表可能写了归档里尚未出现的人（比如他还没发过言），此时不返回它
        const exact = users.filter((u) => u.toLowerCase() === canonical.toLowerCase());
        if (exact.length) return exact;
    }

    const eq = users.filter((u) => u.toLowerCase() === q);
    if (eq.length) return eq;

    return users.filter((u) => u.toLowerCase().includes(q));
}

/** 别名 → 可用于 BM25 查询扩展的同义词（真名 + 其它别名）。 */
function expandPersonTerms(person, aliases = new Map()) {
    const q = String(person ?? '')
        .trim()
        .toLowerCase();
    if (!q) return [];
    const canonical = aliases.get(q);
    if (!canonical) return [];
    const terms = new Set([canonical]);
    for (const [alias, name] of aliases) {
        if (name === canonical && alias !== q) terms.add(alias);
    }
    return [...terms];
}

function clearAliasCache() {
    for (const k in cache) delete cache[k];
}

module.exports = {
    loadAliases,
    resolvePerson,
    expandPersonTerms,
    aliasPathFor,
    ALIAS_FILE,
    clearAliasCache,
};
