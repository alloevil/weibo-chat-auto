#!/usr/bin/env node
/**
 * run-tests.js — 显式列出测试文件，再交给 Node 的测试运行器。
 *
 * 不使用 `node --test` 的工作区遍历：仓库曾有软链/本地 agent 文件被不同 Node 版本误识别为
 * 测试文件。这里显式列出 `test/` 下所有 `*.test.{js,mjs,cjs}`，让测试集合跨平台、可读、可核对。
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

// 允许 `npm test -- --test-reporter=tap` 这类调用固定输出格式（claims 收据会用）。
const extraArgs = process.argv.slice(2);
const result = spawnSync(process.execPath, ['--test', ...extraArgs, ...files], {
    stdio: 'inherit',
});
process.exit(result.status === null ? 1 : result.status);
