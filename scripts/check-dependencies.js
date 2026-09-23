#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const { compareInstalledLock } = require('../lib/dependency-state');

const ROOT = path.join(__dirname, '..');

function readJson(file) {
    return JSON.parse(fs.readFileSync(file, 'utf-8'));
}

try {
    const rootLock = readJson(path.join(ROOT, 'package-lock.json'));
    const installedLock = readJson(path.join(ROOT, 'node_modules', '.package-lock.json'));
    const problems = compareInstalledLock(rootLock, installedLock);
    if (problems.length) {
        console.error(`npm 依赖需要同步：\n- ${problems.join('\n- ')}`);
        process.exitCode = 1;
    }
} catch (e) {
    console.error(`npm 依赖状态无法确认：${e.message}`);
    process.exitCode = 1;
}
