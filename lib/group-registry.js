'use strict';

const fs = require('fs');
const path = require('path');
const { writePrivateJson } = require('./private-json');
const { resolveGroupStorageKey, validateGroupStorageIdentity } = require('./group-storage');

function readRegistry(file) {
    try {
        const data = JSON.parse(fs.readFileSync(file, 'utf-8'));
        return data && Array.isArray(data.groups) ? data : { schemaVersion: 1, groups: [] };
    } catch {
        return { schemaVersion: 1, groups: [] };
    }
}

function planRegistryUpdate({ file, names, sessions, outputDir, stateDir }) {
    const existing = readRegistry(file);
    const sessionByName = new Map(
        (Array.isArray(sessions) ? sessions : []).map((session) => [String(session.name), session])
    );
    const existingByName = new Map(existing.groups.map((group) => [group.groupName, group]));
    const groups = [];
    const seenKeys = new Map();
    for (const rawName of Array.isArray(names) ? names : []) {
        const groupName = String(rawName ?? '').trim();
        if (!groupName || groups.some((group) => group.groupName === groupName)) continue;
        const session = sessionByName.get(groupName);
        const previous = existingByName.get(groupName);
        const groupId = session?.id || previous?.groupId || '';
        const storageKey = resolveGroupStorageKey(outputDir, stateDir, groupName, { groupId });
        const identity = validateGroupStorageIdentity(
            outputDir,
            stateDir,
            storageKey,
            groupName,
            groupId
        );
        if (!identity.ok) {
            return { ok: false, error: `群「${groupName}」不能复用现有存储：${identity.error}` };
        }
        if (seenKeys.has(storageKey) && seenKeys.get(storageKey) !== groupName) {
            return {
                ok: false,
                error: `群「${seenKeys.get(storageKey)}」与「${groupName}」仍指向同一旧目录 ${storageKey}`,
            };
        }
        seenKeys.set(storageKey, groupName);
        groups.push({
            groupName,
            groupId: groupId ? String(groupId) : '',
            storageKey,
            updatedAt: new Date().toISOString(),
        });
    }
    return { ok: true, registry: { schemaVersion: 1, groups } };
}

function writeRegistry(file, registry) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    writePrivateJson(file, registry);
}

module.exports = { readRegistry, planRegistryUpdate, writeRegistry };
