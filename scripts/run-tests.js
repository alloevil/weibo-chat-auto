#!/usr/bin/env node
/**
 * run-tests.js — 显式列出测试文件，再交给 Node 的测试运行器。
 *
 * 为什么不用 `node --test` 的无参形式：它靠工作区遍历发现用例，而这个仓库根有一个提交进去的
 * 软链 `CLAUDE.md -> AGENTS.md`；Node 20 的遍历会把它当成待跑文件，直接报
 * `Could not find '.../CLAUDE.md'`（Node 22 不会）。于是同一份代码在本地绿、在 CI 红。
 *
 * 为什么不用 `node --test ...` 的 glob：glob 形式要 Node 21+ 才支持，Node 20 会把它当成
 * 不存在的路径（`Could not find '.../test/**\/*.test.js'`）。
 *
 * 所以这里把「哪些文件算测试」写成代码：`test/` 下所有 `*.test.{js,mjs,cjs}`。跨版本、跨平台，
 * 并且把测试集合本身变成一件可读、可核对的事（与其他产物同一套纪律）。
 */
'use strict';

const { readdirSync } = require('node:fs');
const { spawnSync } = require('node:child_process');
const path = require('node:path');

const TEST_DIR = path.join(__dirname, '..', 'test');
const PATTERN = /\.test\.(js|mjs|cjs)$/;

const files = readdirSync(TEST_DIR)
    .filter((name) => PATTERN.test(name))
    .sort()
    .map((name) => path.join('test', name));

if (files.length === 0) {
    console.error(`no test files matching ${PATTERN} under ${TEST_DIR}`);
    process.exit(1);
}

const result = spawnSync(process.execPath, ['--test', ...files], { stdio: 'inherit' });
process.exit(result.status === null ? 1 : result.status);
