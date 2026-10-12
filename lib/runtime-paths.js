'use strict';

const path = require('node:path');

const sourceRoot = path.join(__dirname, '..');
const resourceRoot = process.env.WEIBO_RESOURCE_ROOT
    ? path.resolve(process.env.WEIBO_RESOURCE_ROOT)
    : sourceRoot;
const dataRoot = process.env.WEIBO_DATA_ROOT
    ? path.resolve(process.env.WEIBO_DATA_ROOT)
    : sourceRoot;

function taskCommand(task, args = []) {
    const scripts = { archive: 'auto-archive-simple.js', index: 'build-qa-index.mjs' };
    if (!Object.hasOwn(scripts, task)) throw new Error(`Unknown desktop task: ${task}`);
    if (process.env.WEIBO_TASK_EXECUTABLE) {
        return {
            executable: process.env.WEIBO_TASK_EXECUTABLE,
            args: [task, ...args],
        };
    }
    return {
        executable: process.execPath,
        args: [path.join(sourceRoot, 'scripts', scripts[task]), ...args],
    };
}

module.exports = { resourceRoot, dataRoot, taskCommand };
