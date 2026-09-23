// 群名到本地目录/状态文件名的统一映射。
//
// 当前格式是历史兼容格式：把文件系统不安全或不便携的字符替换成 `_`。
// 这个映射不是一一对应的（例如 `项目🔥` 与 `项目❤️` 都会变成 `项目__`），
// 因此所有写入入口必须先用 findLegacyKeyCollisions 拒绝碰撞。未来若迁移到带
// hash 的新格式，也应只在这里实现，避免归档器、查看器和修复工具各写一份。
'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { writePrivateJson } = require('./private-json');

const GROUP_META_FILE = '.group-meta.json';

function legacyGroupKey(groupName) {
    return String(groupName ?? '').replace(/[^a-zA-Z0-9一-鿿]/g, '_');
}

function uniqueGroupKey(groupName) {
    const name = String(groupName ?? '').trim();
    const readable =
        legacyGroupKey(name)
            .replace(/^_+|_+$/g, '')
            .slice(0, 48) || 'group';
    const digest = crypto.createHash('sha256').update(name).digest('hex').slice(0, 12);
    return `${readable}__${digest}`;
}

function readJson(file, fsImpl = fs) {
    try {
        return JSON.parse(fsImpl.readFileSync(file, 'utf-8'));
    } catch {
        return null;
    }
}

function readGroupMetadata(groupDir, fsImpl = fs) {
    const meta = readJson(path.join(groupDir, GROUP_META_FILE), fsImpl);
    return meta && typeof meta === 'object' ? meta : null;
}

function writeGroupMetadata(groupDir, { groupName, groupId, storageKey }) {
    fs.mkdirSync(groupDir, { recursive: true });
    writePrivateJson(path.join(groupDir, GROUP_META_FILE), {
        schemaVersion: 1,
        groupName: String(groupName),
        groupId: String(groupId),
        storageKey: String(storageKey),
    });
}

/**
 * 新群使用唯一 key；已有旧目录/状态继续兼容。若旧身份明确属于另一个群，
 * 则改用唯一 key，绝不复用对方的目录或断点。
 */
function resolveGroupStorageKey(
    outputDir,
    stateDir,
    groupName,
    { groupId = '', fsImpl = fs } = {}
) {
    const name = String(groupName ?? '').trim();
    const uniqueKey = uniqueGroupKey(name);
    const legacyKey = legacyGroupKey(name);
    const uniqueDir = path.join(outputDir, uniqueKey);
    const uniqueState = path.join(stateDir, `last-archive-state_${uniqueKey}.json`);
    if (fsImpl.existsSync(uniqueDir) || fsImpl.existsSync(uniqueState)) return uniqueKey;

    const legacyDir = path.join(outputDir, legacyKey);
    const legacyStatePath = path.join(stateDir, `last-archive-state_${legacyKey}.json`);
    if (!fsImpl.existsSync(legacyDir) && !fsImpl.existsSync(legacyStatePath)) return uniqueKey;

    const metadata = readGroupMetadata(legacyDir, fsImpl);
    const state = readJson(legacyStatePath, fsImpl);
    if (metadata?.groupName && String(metadata.groupName) !== name) return uniqueKey;
    if (state?.groupName && String(state.groupName) !== name) return uniqueKey;
    if (groupId) {
        if (metadata?.groupId && String(metadata.groupId) !== String(groupId)) return uniqueKey;
        if (state?.groupId && String(state.groupId) !== String(groupId)) return uniqueKey;
    }
    return legacyKey;
}

function findResolvedKeyCollisions(groupNames, resolveKey) {
    const byKey = new Map();
    for (const value of Array.isArray(groupNames) ? groupNames : []) {
        const name = String(value ?? '').trim();
        if (!name) continue;
        const key = resolveKey(name);
        if (!byKey.has(key)) byKey.set(key, new Set());
        byKey.get(key).add(name);
    }
    return [...byKey.entries()]
        .filter(([, names]) => names.size > 1)
        .map(([key, names]) => ({ key, names: [...names] }));
}

/**
 * 找出不同群名映射到同一个历史存储键的情况。
 * 相同名称重复出现不算碰撞；配置层会另外负责去重。
 * @param {unknown[]} groupNames
 * @returns {{key:string, names:string[]}[]}
 */
function findLegacyKeyCollisions(groupNames) {
    const byKey = new Map();
    for (const value of Array.isArray(groupNames) ? groupNames : []) {
        const name = String(value ?? '').trim();
        if (!name) continue;
        const key = legacyGroupKey(name);
        if (!byKey.has(key)) byKey.set(key, new Set());
        byKey.get(key).add(name);
    }
    return [...byKey.entries()]
        .filter(([, names]) => names.size > 1)
        .map(([key, names]) => ({ key, names: [...names] }));
}

function describeLegacyKeyCollisions(collisions) {
    return (Array.isArray(collisions) ? collisions : [])
        .map(({ key, names }) => `「${names.join('」「')}」都会写入 ${key}`)
        .join('；');
}

/**
 * 核对历史状态是否确实属于当前点击到的群。
 * 旧状态没有 groupName，仍可用 groupId 核对；两者都没有时保持向后兼容。
 */
function validateStoredGroupIdentity(state, groupName, groupId) {
    if (!state || typeof state !== 'object') return { ok: true };
    const currentName = String(groupName ?? '');
    const currentId = String(groupId ?? '');
    if (state.groupName && String(state.groupName) !== currentName) {
        return {
            ok: false,
            error: `状态文件属于群「${state.groupName}」，当前群是「${currentName}」`,
        };
    }
    if (state.groupId && currentId && String(state.groupId) !== currentId) {
        return {
            ok: false,
            error: `状态文件的群 ID ${state.groupId} 与当前解析出的 ${currentId} 不一致`,
        };
    }
    return { ok: true };
}

function validateGroupStorageIdentity(
    outputDir,
    stateDir,
    storageKey,
    groupName,
    groupId,
    fsImpl = fs
) {
    const metadata = readGroupMetadata(path.join(outputDir, storageKey), fsImpl);
    const state = readJson(path.join(stateDir, `last-archive-state_${storageKey}.json`), fsImpl);
    for (const identity of [metadata, state]) {
        const result = validateStoredGroupIdentity(identity, groupName, groupId);
        if (!result.ok) return result;
    }
    return { ok: true };
}

module.exports = {
    GROUP_META_FILE,
    legacyGroupKey,
    uniqueGroupKey,
    resolveGroupStorageKey,
    readGroupMetadata,
    writeGroupMetadata,
    findLegacyKeyCollisions,
    findResolvedKeyCollisions,
    describeLegacyKeyCollisions,
    validateStoredGroupIdentity,
    validateGroupStorageIdentity,
};
