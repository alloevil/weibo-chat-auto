const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const root = path.resolve(__dirname, '..');

function runNode(source, env = {}) {
    const result = spawnSync(process.execPath, ['-e', source], {
        cwd: root,
        env: {
            ...process.env,
            WEIBO_RESOURCE_ROOT: '',
            WEIBO_DATA_ROOT: '',
            WEIBO_TASK_EXECUTABLE: '',
            WEIBO_COOKIE_FILE: '',
            ...env,
        },
        encoding: 'utf8',
        timeout: 10000,
    });
    assert.equal(result.status, 0, result.stderr);
    return JSON.parse(result.stdout);
}

test('runtime paths: source mode preserves repository data and Node script commands', () => {
    const actual = runNode(
        'const paths=require("./lib/runtime-paths");console.log(JSON.stringify({...paths,command:paths.taskCommand("index",["--group","synthetic"])}))'
    );
    assert.equal(actual.resourceRoot, root);
    assert.equal(actual.dataRoot, root);
    assert.deepEqual(actual.command, {
        executable: process.execPath,
        args: [path.join(root, 'scripts/build-qa-index.mjs'), '--group', 'synthetic'],
    });
});

test('runtime paths: packaged resources, writable data and worker are independent', () => {
    const resources = path.join(os.tmpdir(), 'app resources');
    const data = path.join(os.tmpdir(), 'app data');
    const worker = path.join(resources, 'archive-worker');
    const actual = runNode(
        'const paths=require("./lib/runtime-paths");console.log(JSON.stringify({...paths,archive:paths.taskCommand("archive"),index:paths.taskCommand("index",["--group","含 空格"])}))',
        { WEIBO_RESOURCE_ROOT: resources, WEIBO_DATA_ROOT: data, WEIBO_TASK_EXECUTABLE: worker }
    );
    assert.equal(actual.resourceRoot, resources);
    assert.equal(actual.dataRoot, data);
    assert.deepEqual(actual.archive, { executable: worker, args: ['archive'] });
    assert.deepEqual(actual.index, {
        executable: worker,
        args: ['index', '--group', '含 空格'],
    });
});

test('runtime paths: arbitrary task names are rejected', () => {
    const { taskCommand } = require('../lib/runtime-paths');
    for (const task of ['../viewer-server', 'toString', 'constructor', 'unknown']) {
        assert.throws(() => taskCommand(task), /Unknown desktop task/);
    }
});

test('desktop archive worker: no login exits before config, Chrome or network access', (context) => {
    const data = fs.mkdtempSync(path.join(os.tmpdir(), 'weibo-worker-test-'));
    context.after(() => fs.rmSync(data, { recursive: true, force: true }));
    const result = spawnSync(process.execPath, ['sidecar/archive-worker.mjs', 'archive'], {
        cwd: root,
        env: {
            ...process.env,
            WEIBO_DATA_ROOT: data,
            WEIBO_COOKIE_FILE: path.join(data, 'absent-cookies.json'),
        },
        encoding: 'utf8',
        timeout: 10000,
    });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /请先在应用内扫码登录/);
    assert.doesNotMatch(result.stderr, /ENOENT|Cannot find module/);
    assert.deepEqual(fs.readdirSync(data), []);
});

test('desktop index worker: no AI config writes only to the specified data directory', (context) => {
    const data = fs.mkdtempSync(path.join(os.tmpdir(), 'weibo-index-test-'));
    context.after(() => fs.rmSync(data, { recursive: true, force: true }));
    const group = path.join(data, 'output', 'synthetic');
    fs.mkdirSync(group, { recursive: true });
    fs.writeFileSync(
        path.join(group, 'weibo_chat_2026-10-12.json'),
        JSON.stringify({
            messages: [
                {
                    id: 'sample',
                    user: '合成用户',
                    content: '部署 回滚',
                    timestamp: Date.parse('2026-10-12T10:00:00Z'),
                    time: '2026/10/12 10:00:00',
                    date: '2026-10-12',
                },
            ],
        })
    );
    const result = spawnSync(
        process.execPath,
        ['sidecar/archive-worker.mjs', 'index', '--group', 'synthetic', '--all'],
        {
            cwd: root,
            env: { ...process.env, WEIBO_DATA_ROOT: data },
            encoding: 'utf8',
            timeout: 10000,
        }
    );
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /LLM 调用 0/);
    assert.equal((result.stdout.match(/\[index\] 完成:/g) || []).length, 1);
    const index = JSON.parse(
        fs.readFileSync(path.join(group, 'qa-index', 'chunks_2026-10-12.json'), 'utf8')
    );
    assert.equal(index.sourceCount, 1);
    assert.deepEqual(index.chunks[0].msgIds, ['sample']);
});

test('Tauri bundles only staged runtime resources and passes explicit data paths', () => {
    const config = require('../src-tauri/tauri.conf.json');
    assert.equal(config.bundle.resources['../sidecar/resources/'], 'runtime/');
    const rust = fs.readFileSync(path.join(root, 'src-tauri/src/lib.rs'), 'utf8');
    for (const name of ['WEIBO_DATA_ROOT', 'WEIBO_RESOURCE_ROOT', 'WEIBO_TASK_EXECUTABLE']) {
        assert.ok(rust.includes(`.env("${name}"`));
    }
    assert.match(rust, /安装包缺少runtime\/viewer\.html/);
    const build = fs.readFileSync(path.join(root, 'sidecar/build.mjs'), 'utf8');
    for (const file of ['viewer.html', 'lib/text-utils.js', 'lib/viewer-filters.js']) {
        assert.ok(build.includes(`'${file}'`));
    }
    assert.doesNotMatch(build, /config\.json|cookies\.json|\.env/);
});
