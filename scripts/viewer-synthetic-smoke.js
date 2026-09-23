#!/usr/bin/env node
// 完全使用虚构数据的 viewer 集成烟测；不读取仓库 output/，不访问微博。
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { uniqueGroupKey, writeGroupMetadata } = require('../lib/group-storage');
const { writeRegistry } = require('../lib/group-registry');

const ROOT = path.join(__dirname, '..');
const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'weibo-viewer-smoke-'));
const outputDir = path.join(dataRoot, 'output');
const stateDir = path.join(dataRoot, 'state');
const groups = [
    { name: '合成项目🔥', id: '900001', user: '测试甲', content: '第一组的虚构消息' },
    { name: '合成项目❤️', id: '900002', user: '测试乙', content: '第二组的虚构消息' },
];

function writeFixture() {
    fs.mkdirSync(outputDir, { recursive: true });
    fs.mkdirSync(path.join(dataRoot, 'cache'), { recursive: true });
    fs.writeFileSync(
        path.join(dataRoot, 'cache', 'emotions.json'),
        JSON.stringify({
            fetchedAt: Date.now(),
            map: { '[合成表情]': 'https://example.invalid/emotion.png' },
        })
    );
    fs.writeFileSync(
        path.join(dataRoot, 'config.json'),
        JSON.stringify({ chromePath: '', groups: groups.map((group) => group.name) })
    );
    const registry = { schemaVersion: 1, groups: [] };
    for (const [index, group] of groups.entries()) {
        const storageKey = uniqueGroupKey(group.name);
        const groupDir = path.join(outputDir, storageKey);
        const date = `2026-09-${String(20 + index).padStart(2, '0')}`;
        fs.mkdirSync(groupDir, { recursive: true });
        fs.writeFileSync(
            path.join(groupDir, `weibo_chat_${date}.json`),
            JSON.stringify([
                {
                    id: `${group.id}01`,
                    user: group.user,
                    timestamp: Date.parse(`${date}T12:00:00+09:00`),
                    time: `${date.replace(/-/g, '/')} 12:00:00`,
                    date,
                    content: group.content,
                    pics: [],
                },
            ])
        );
        writeGroupMetadata(groupDir, {
            groupName: group.name,
            groupId: group.id,
            storageKey,
        });
        registry.groups.push({
            groupName: group.name,
            groupId: group.id,
            storageKey,
            updatedAt: '2026-09-22T00:00:00.000Z',
        });
    }
    writeRegistry(path.join(stateDir, 'group-registry.json'), registry);
}

function runSwitchCheck(port) {
    return new Promise((resolve, reject) => {
        const child = spawn(process.execPath, [path.join(__dirname, 'check-switch-group.js')], {
            cwd: ROOT,
            env: { ...process.env, WEIBO_PORT: String(port) },
            stdio: 'inherit',
        });
        child.on('error', reject);
        child.on('exit', (code) =>
            code === 0 ? resolve() : reject(new Error(`check-switch-group 退出码 ${code}`))
        );
    });
}

async function main() {
    writeFixture();
    process.env.WEIBO_DATA_ROOT = dataRoot;
    process.env.WEIBO_COOKIE_FILE = path.join(dataRoot, 'cookies.json');
    process.env.NO_OPEN = '1';
    const { createViewerServer } = require('./viewer-server');
    const server = createViewerServer();
    try {
        await new Promise((resolve, reject) => {
            server.once('error', reject);
            server.listen(0, '127.0.0.1', resolve);
        });
        await runSwitchCheck(server.address().port);
        console.log('合成 viewer smoke 通过');
    } finally {
        await new Promise((resolve) => server.close(resolve));
        fs.rmSync(dataRoot, { recursive: true, force: true });
    }
}

main().catch((error) => {
    console.error(error.message);
    fs.rmSync(dataRoot, { recursive: true, force: true });
    process.exit(1);
});
