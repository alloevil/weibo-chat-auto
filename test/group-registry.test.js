const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { readRegistry, planRegistryUpdate, writeRegistry } = require('../lib/group-registry');
const { uniqueGroupKey } = require('../lib/group-storage');

function layout() {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'group-registry-test-'));
    const outputDir = path.join(root, 'output');
    const stateDir = path.join(root, 'state');
    const file = path.join(stateDir, 'group-registry.json');
    fs.mkdirSync(outputDir);
    return { outputDir, stateDir, file };
}

test('planRegistryUpdate: 选群时保存已验证 groupId 与唯一 key', () => {
    const ctx = layout();
    const plan = planRegistryUpdate({
        ...ctx,
        names: ['项目🔥', '项目❤️'],
        sessions: [
            { name: '项目🔥', id: '100' },
            { name: '项目❤️', id: '200' },
        ],
    });
    assert.strictEqual(plan.ok, true);
    assert.deepStrictEqual(
        plan.registry.groups.map((group) => [group.groupName, group.groupId, group.storageKey]),
        [
            ['项目🔥', '100', uniqueGroupKey('项目🔥')],
            ['项目❤️', '200', uniqueGroupKey('项目❤️')],
        ]
    );
    writeRegistry(ctx.file, plan.registry);
    assert.deepStrictEqual(readRegistry(ctx.file), plan.registry);
    assert.strictEqual(fs.statSync(ctx.file).mode & 0o777, 0o600);
});

test('planRegistryUpdate: 会话列表暂缺时保留已有可靠 ID', () => {
    const ctx = layout();
    writeRegistry(ctx.file, {
        schemaVersion: 1,
        groups: [
            {
                groupName: '群A',
                groupId: '100',
                storageKey: uniqueGroupKey('群A'),
                updatedAt: 'old',
            },
        ],
    });
    const plan = planRegistryUpdate({ ...ctx, names: ['群A'], sessions: [] });
    assert.strictEqual(plan.ok, true);
    assert.strictEqual(plan.registry.groups[0].groupId, '100');
});
