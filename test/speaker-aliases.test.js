'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const {
    loadAliases,
    resolvePerson,
    expandPersonTerms,
    aliasPathFor,
    clearAliasCache,
} = require('../lib/speaker-aliases');

function withGroupDir(aliasesJson) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'alias-'));
    if (aliasesJson !== undefined) {
        fs.writeFileSync(
            aliasPathFor(dir),
            typeof aliasesJson === 'string' ? aliasesJson : JSON.stringify(aliasesJson)
        );
    }
    clearAliasCache();
    return dir;
}

const USERS = ['tombkeeper', '张三丰', '张三', 'Alice'];

test('别名表把口语称呼解析到真实 user 名', () => {
    const dir = withGroupDir({ tombkeeper: ['tk', 'TK'] });
    const aliases = loadAliases(dir);
    assert.deepStrictEqual(resolvePerson('tk', USERS, aliases), ['tombkeeper']);
    // 别名大小写不敏感
    assert.deepStrictEqual(resolvePerson('TK', USERS, aliases), ['tombkeeper']);
    // 真名自身也走得通
    assert.deepStrictEqual(resolvePerson('tombkeeper', USERS, aliases), ['tombkeeper']);
});

test('精确匹配优先于子串:「张三」不把「张三丰」一起带出来', () => {
    const aliases = new Map();
    assert.deepStrictEqual(resolvePerson('张三', USERS, aliases), ['张三']);
    // 只有在无精确命中时才放宽到子串
    assert.deepStrictEqual(resolvePerson('张三', ['张三丰', '小张三号'], aliases), [
        '张三丰',
        '小张三号',
    ]);
});

test('别名指向的人尚未在语料中发言时不硬造结果', () => {
    const dir = withGroupDir({ 李四: ['ls'] });
    const aliases = loadAliases(dir);
    // 李四不在 USERS 里 → 不返回他，也不误退回子串匹配
    assert.deepStrictEqual(resolvePerson('ls', USERS, aliases), []);
});

test('别名表缺失/损坏时降级为空表，检索行为不变', () => {
    const missing = withGroupDir(undefined);
    assert.strictEqual(loadAliases(missing).size, 0);

    const corrupt = withGroupDir('{ not json');
    assert.strictEqual(loadAliases(corrupt).size, 0);

    const wrongShape = withGroupDir(['tk']);
    assert.strictEqual(loadAliases(wrongShape).size, 0);

    // 无 groupDir(旧调用方)也不炸
    assert.strictEqual(loadAliases(undefined).size, 0);

    // 空表下 resolvePerson 退回原有的精确/子串语义
    assert.deepStrictEqual(resolvePerson('tomb', USERS, loadAliases(missing)), ['tombkeeper']);
});

test('别名重复声明时先声明者优先(行为不随对象键顺序漂移)', () => {
    const dir = withGroupDir({ tombkeeper: ['tk'], 张三: ['tk'] });
    const aliases = loadAliases(dir);
    assert.strictEqual(aliases.get('tk'), 'tombkeeper');
});

test('expandPersonTerms 给出真名与其余别名用于 BM25 扩展', () => {
    const dir = withGroupDir({ tombkeeper: ['tk', 'TK老师'] });
    const aliases = loadAliases(dir);
    const terms = expandPersonTerms('tk', aliases);
    assert.ok(terms.includes('tombkeeper'), '应含真名');
    assert.ok(
        terms.some((t) => t.toLowerCase() === 'tk老师'),
        '应含其它别名'
    );
    assert.ok(!terms.includes('tk'), '不含查询词自身');
    // 未登记的称呼不扩展，避免污染查询
    assert.deepStrictEqual(expandPersonTerms('unknown', aliases), []);
});

test('mtime 变化后重新读表(编辑 aliases.json 立即生效)', () => {
    const dir = withGroupDir({ tombkeeper: ['tk'] });
    assert.strictEqual(loadAliases(dir).get('tk'), 'tombkeeper');

    // 同一路径改写内容并推进 mtime
    fs.writeFileSync(aliasPathFor(dir), JSON.stringify({ Alice: ['tk'] }));
    const future = Date.now() / 1000 + 5;
    fs.utimesSync(aliasPathFor(dir), future, future);

    assert.strictEqual(loadAliases(dir).get('tk'), 'Alice');
});
