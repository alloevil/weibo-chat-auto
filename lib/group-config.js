// config.json 的 groups 写入口（#18 应用内选群）。
//
// config.json 是用户手工文件（chromePath 等字段用户可能自己加过），
// UI 勾选只允许改 groups 一个字段：读入 → 替换 groups → 原子写回，
// 其余字段原样保留。文件缺失时按 config.example.json 的结构新建。
// 手编路径完全不受影响 —— 这里写的就是同一个文件、同一个字段。
'use strict';

const fs = require('fs');

/** 读取当前配置（缺失/损坏返回默认结构；损坏时 raw 带上原文以便调用方决定是否拒写）。 */
function readConfig(file) {
    try {
        const text = fs.readFileSync(file, 'utf-8');
        try {
            const data = JSON.parse(text);
            if (data && typeof data === 'object' && !Array.isArray(data)) return { data, exists: true, corrupt: false };
            return { data: { chromePath: '', groups: [] }, exists: true, corrupt: true };
        } catch {
            return { data: { chromePath: '', groups: [] }, exists: true, corrupt: true };
        }
    } catch {
        return { data: { chromePath: '', groups: [] }, exists: false, corrupt: false };
    }
}

/**
 * 把勾选结果写入 config.json 的 groups 字段。
 * @param {string} file config.json 路径
 * @param {string[]} groups 勾选的群名（去空去重保序）
 * @returns {{ok:true, groups:string[]} | {ok:false, error:string}}
 */
function writeGroups(file, groups) {
    const names = [...new Set((Array.isArray(groups) ? groups : [])
        .map(g => String(g ?? '').trim()).filter(Boolean))];
    if (!names.length) return { ok: false, error: '至少勾选一个群' };

    const { data, corrupt } = readConfig(file);
    if (corrupt) {
        // 损坏的手工文件不覆盖 —— 覆盖等于替用户丢掉他写过的内容
        return { ok: false, error: 'config.json 已存在但无法解析，请先手工修复它' };
    }
    data.groups = names;
    if (data.chromePath === undefined) data.chromePath = '';
    delete data.groupName;   // 旧的单群字段：groups 已是唯一事实源，留着会困惑

    // 原子写：同目录临时文件 + rename（与 lib/day-file 同一理由）
    const tmp = `${file}.tmp-${process.pid}`;
    try {
        fs.writeFileSync(tmp, JSON.stringify(data, null, 4) + '\n', 'utf-8');
        fs.renameSync(tmp, file);
    } catch (e) {
        try { fs.unlinkSync(tmp); } catch {}
        return { ok: false, error: `写入失败: ${e.message}` };
    }
    return { ok: true, groups: names };
}

/** 当前已配置的群名（文件缺失/损坏返回 []）。 */
function readGroups(file) {
    const { data } = readConfig(file);
    const raw = Array.isArray(data.groups) ? data.groups : (data.groupName ? [data.groupName] : []);
    return raw.map(g => String(g ?? '').trim()).filter(Boolean);
}

module.exports = { readConfig, readGroups, writeGroups };
