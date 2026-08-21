const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { readGroups, writeGroups } = require('../lib/group-config.js');

function tmpfile() {
    return path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'group-config-test-')), 'config.json');
}

test('writeGroups: 文件缺失时新建,结构与 config.example.json 一致', () => {
    const file = tmpfile();
    const r = writeGroups(file, ['群A', '群B']);
    assert.strictEqual(r.ok, true);
    const data = JSON.parse(fs.readFileSync(file, 'utf-8'));
    assert.deepStrictEqual(data, { chromePath: '', groups: ['群A', '群B'] });
});

test('writeGroups: 保留用户手工加的字段,只改 groups', () => {
    const file = tmpfile();
    fs.writeFileSync(file, JSON.stringify({ chromePath: '/opt/chrome', groups: ['旧群'], myNote: '手工注释' }));
    const r = writeGroups(file, ['新群']);
    assert.strictEqual(r.ok, true);
    const data = JSON.parse(fs.readFileSync(file, 'utf-8'));
    assert.strictEqual(data.chromePath, '/opt/chrome');
    assert.strictEqual(data.myNote, '手工注释');
    assert.deepStrictEqual(data.groups, ['新群']);
});

test('writeGroups: 去空去重保序;全空拒写', () => {
    const file = tmpfile();
    const r = writeGroups(file, [' 群A ', '群A', '', null, '群B']);
    assert.deepStrictEqual(r.groups, ['群A', '群B']);
    const bad = writeGroups(file, ['', '  ']);
    assert.strictEqual(bad.ok, false);
    assert.match(bad.error, /至少/);
    // 拒写不应破坏已有内容
    assert.deepStrictEqual(JSON.parse(fs.readFileSync(file, 'utf-8')).groups, ['群A', '群B']);
});

test('writeGroups: 损坏的手工 config.json 拒绝覆盖', () => {
    const file = tmpfile();
    fs.writeFileSync(file, '{"groups": ["半截');
    const r = writeGroups(file, ['群A']);
    assert.strictEqual(r.ok, false);
    assert.match(r.error, /无法解析/);
    assert.strictEqual(fs.readFileSync(file, 'utf-8'), '{"groups": ["半截', '原文件原样保留');
});

test('writeGroups: 清除旧的单群字段 groupName', () => {
    const file = tmpfile();
    fs.writeFileSync(file, JSON.stringify({ groupName: '老群', groups: ['老群'] }));
    writeGroups(file, ['新群']);
    const data = JSON.parse(fs.readFileSync(file, 'utf-8'));
    assert.strictEqual('groupName' in data, false);
});

test('readGroups: 正常/旧 groupName 形态/缺失/损坏', () => {
    const file = tmpfile();
    assert.deepStrictEqual(readGroups(file), []);
    fs.writeFileSync(file, JSON.stringify({ groups: ['群A', ' '] }));
    assert.deepStrictEqual(readGroups(file), ['群A']);
    fs.writeFileSync(file, JSON.stringify({ groupName: '单群' }));
    assert.deepStrictEqual(readGroups(file), ['单群']);
    fs.writeFileSync(file, '不是 JSON');
    assert.deepStrictEqual(readGroups(file), []);
});
