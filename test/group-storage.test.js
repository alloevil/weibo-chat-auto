const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {
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
} = require('../lib/group-storage');

function tempLayout() {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'group-storage-test-'));
    const outputDir = path.join(root, 'output');
    const stateDir = path.join(root, 'state');
    fs.mkdirSync(outputDir);
    fs.mkdirSync(stateDir);
    return { root, outputDir, stateDir };
}

test('legacyGroupKey: 与历史目录命名兼容', () => {
    assert.strictEqual(legacyGroupKey('中文群（一）'), '中文群_一_');
    assert.strictEqual(legacyGroupKey('A/B'), 'A_B');
    assert.strictEqual(legacyGroupKey('普通群123'), '普通群123');
});

test('findLegacyKeyCollisions: 不同群名映射到同一目录时明确报告', () => {
    const collisions = findLegacyKeyCollisions(['项目🔥', '项目❤️', '普通群', '普通群']);
    assert.deepStrictEqual(collisions, [{ key: '项目__', names: ['项目🔥', '项目❤️'] }]);
    assert.match(describeLegacyKeyCollisions(collisions), /项目🔥/);
    assert.match(describeLegacyKeyCollisions(collisions), /项目❤️/);
    assert.match(describeLegacyKeyCollisions(collisions), /项目__/);
});

test('findLegacyKeyCollisions: 空值、空白和同名重复不算碰撞', () => {
    assert.deepStrictEqual(findLegacyKeyCollisions(['群A', ' 群A ', '', null]), []);
});

test('uniqueGroupKey: 保留可读前缀并用原名 hash 消除旧规则碰撞', () => {
    const fire = uniqueGroupKey('项目🔥');
    const heart = uniqueGroupKey('项目❤️');
    assert.match(fire, /^项目__[a-f0-9]{12}$/);
    assert.match(heart, /^项目__[a-f0-9]{12}$/);
    assert.notStrictEqual(fire, heart);
    assert.strictEqual(uniqueGroupKey('项目🔥'), fire, '同名必须稳定');
});

test('resolveGroupStorageKey: 新群用唯一 key，旧目录继续兼容', () => {
    const { outputDir, stateDir } = tempLayout();
    assert.strictEqual(
        resolveGroupStorageKey(outputDir, stateDir, '项目🔥'),
        uniqueGroupKey('项目🔥')
    );

    fs.mkdirSync(path.join(outputDir, legacyGroupKey('旧群🔥')));
    assert.strictEqual(
        resolveGroupStorageKey(outputDir, stateDir, '旧群🔥'),
        legacyGroupKey('旧群🔥')
    );
});

test('resolveGroupStorageKey: 旧目录身份属于别群时转用唯一 key', () => {
    const { outputDir, stateDir } = tempLayout();
    const legacyDir = path.join(outputDir, legacyGroupKey('项目🔥'));
    writeGroupMetadata(legacyDir, {
        groupName: '项目🔥',
        groupId: '100',
        storageKey: legacyGroupKey('项目🔥'),
    });
    assert.strictEqual(readGroupMetadata(legacyDir).groupName, '项目🔥');
    assert.strictEqual(
        resolveGroupStorageKey(outputDir, stateDir, '项目❤️', { groupId: '200' }),
        uniqueGroupKey('项目❤️')
    );
});

test('findResolvedKeyCollisions: 无身份的旧目录仍 fail closed', () => {
    const { outputDir, stateDir } = tempLayout();
    fs.mkdirSync(path.join(outputDir, legacyGroupKey('项目🔥')));
    const collisions = findResolvedKeyCollisions(['项目🔥', '项目❤️'], (name) =>
        resolveGroupStorageKey(outputDir, stateDir, name)
    );
    assert.deepStrictEqual(collisions, [{ key: '项目__', names: ['项目🔥', '项目❤️'] }]);
});

test('validateStoredGroupIdentity: 兼容旧状态并接受同一群', () => {
    assert.deepStrictEqual(validateStoredGroupIdentity(null, '群A', '100'), { ok: true });
    assert.deepStrictEqual(validateStoredGroupIdentity({ lastTimestamp: 1 }, '群A', '100'), {
        ok: true,
    });
    assert.deepStrictEqual(
        validateStoredGroupIdentity({ groupName: '群A', groupId: '100' }, '群A', 100),
        { ok: true }
    );
});

test('validateStoredGroupIdentity: 群名或 groupId 不一致时拒绝旧断点', () => {
    const wrongName = validateStoredGroupIdentity(
        { groupName: '项目🔥', groupId: '100' },
        '项目❤️',
        '100'
    );
    assert.strictEqual(wrongName.ok, false);
    assert.match(wrongName.error, /状态文件属于群/);

    const wrongId = validateStoredGroupIdentity({ groupId: '100' }, '群A', '200');
    assert.strictEqual(wrongId.ok, false);
    assert.match(wrongId.error, /群 ID/);
});

test('validateGroupStorageIdentity: 同名但 groupId 变化时不覆盖旧元数据', () => {
    const { outputDir, stateDir } = tempLayout();
    const name = '同名群';
    const key = uniqueGroupKey(name);
    writeGroupMetadata(path.join(outputDir, key), {
        groupName: name,
        groupId: '100',
        storageKey: key,
    });
    const result = validateGroupStorageIdentity(outputDir, stateDir, key, name, '200');
    assert.strictEqual(result.ok, false);
    assert.match(result.error, /群 ID/);
});
