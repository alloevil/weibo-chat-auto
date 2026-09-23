const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const setup = fs.readFileSync(path.join(root, 'scripts', 'setup.sh'), 'utf-8');
const schedule = fs.readFileSync(path.join(root, 'scripts', 'schedule.sh'), 'utf-8');

test('setup: Node 版本检查早于 npm install', () => {
    assert.ok(setup.indexOf('scripts/check-node-version.js') < setup.indexOf('npm install'));
});

test('setup: config 创建早于 Chrome 检测，且 Node 只用当前目录相对 require', () => {
    assert.ok(
        setup.indexOf('cp "$ROOT_DIR/config.example.json"') < setup.indexOf('resolveChromePath')
    );
    assert.match(setup, /require\("\.\/config\.json"\)/);
    assert.match(setup, /require\("\.\/lib\/chrome-path"\)/);
    assert.doesNotMatch(setup, /require\(['"]\$ROOT_DIR/);
});

test('setup/schedule: Windows Git Bash 有明确分支且不落入 cron', () => {
    for (const source of [setup, schedule]) assert.match(source, /MINGW\*\|MSYS\*\|CYGWIN\*/);
    assert.match(setup, /WINDOWS_NATIVE/);
    assert.match(schedule, /Windows 任务计划程序/);
});

test('package script: npm run setup 显式通过 bash 执行', () => {
    const scripts = require('../package.json').scripts;
    assert.strictEqual(scripts.setup, 'bash ./scripts/setup.sh');
    assert.strictEqual(scripts.preinstall, 'node scripts/check-node-version.js');
});
