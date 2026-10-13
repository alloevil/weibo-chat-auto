const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { PassThrough } = require('node:stream');
const { setImmediate } = require('node:timers');

test('sync status HTTP: success, zero-new success, failure, restart, corrupt and failed persistence', async (context) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sync-http-test-'));
    process.env.WEIBO_DATA_ROOT = root;
    process.env.WEIBO_COOKIE_FILE = path.join(root, 'absent-cookies.json');
    const auth = require('../lib/weibo-auth');
    let authCode = 0;
    context.mock.method(auth, 'probeAuthCodeHttp', async () => authCode);
    const childProcess = require('node:child_process');
    let exitCode = 0;
    let output = '--- 归档群聊: 合成群 ---\n完成！\n';
    let launchError = false;
    let launches = 0;
    let releaseCompletion;
    let notifyStarted;
    context.mock.method(childProcess, 'spawn', () => {
        launches++;
        const child = new EventEmitter();
        child.stdout = new PassThrough();
        child.stderr = new PassThrough();
        child.kill = () => {};
        const complete = () => {
            if (launchError) child.emit('error', new Error('synthetic spawn error'));
            else {
                child.stdout.write(output);
                child.emit('close', exitCode);
            }
        };
        setImmediate(() => {
            if (notifyStarted) {
                releaseCompletion = complete;
                notifyStarted();
            } else complete();
        });
        return child;
    });
    const { createViewerServer } = require('../scripts/viewer-server');
    let server = createViewerServer();
    context.after(async () => {
        if (server.listening) await new Promise((resolve) => server.close(resolve));
        delete global.__syncProgress;
        fs.rmSync(root, { recursive: true, force: true });
    });
    const listen = () => new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    await listen();
    const request = async (route, method = 'GET') => {
        const response = await fetch(`http://127.0.0.1:${server.address().port}${route}`, {
            method,
        });
        return { status: response.status, headers: response.headers, body: await response.json() };
    };
    const empty = await request('/api/sync-status');
    assert.deepEqual(empty.body, { ok: true, lastSuccessfulSyncAt: null });
    assert.equal(empty.headers.get('cache-control'), 'no-store');
    assert.equal(launches, 0);
    const startedAt = Date.now();
    const started = new Promise((resolve) => {
        notifyStarted = resolve;
    });
    const pending = request('/api/sync', 'POST');
    await started;
    assert.equal((await request('/api/sync-status')).body.lastSuccessfulSyncAt, null);
    assert.equal(fs.existsSync(path.join(root, 'state', 'sync-status.json')), false);
    const completedAt = Date.now();
    notifyStarted = null;
    releaseCompletion();
    const success = await pending;
    assert.equal(success.body.ok, true);
    assert.equal(success.body.syncTimeSaved, true);
    assert.ok(Date.parse(success.body.lastSuccessfulSyncAt) >= startedAt);
    assert.ok(Date.parse(success.body.lastSuccessfulSyncAt) >= completedAt);
    assert.ok(Date.parse(success.body.lastSuccessfulSyncAt) <= Date.now());
    const stateFile = path.join(root, 'state', 'sync-status.json');
    const original = fs.readFileSync(stateFile, 'utf8');
    exitCode = 1;
    output = '错误: Error: 1/2 个群未归档\n';
    assert.equal((await request('/api/sync', 'POST')).body.ok, false);
    assert.equal(fs.readFileSync(stateFile, 'utf8'), original);
    launchError = true;
    assert.equal((await request('/api/sync', 'POST')).body.ok, false);
    assert.equal(fs.readFileSync(stateFile, 'utf8'), original);
    launchError = false;
    authCode = auth.UNAUTHENTICATED_CODE;
    assert.equal((await request('/api/sync', 'POST')).body.needLogin, true);
    assert.equal(fs.readFileSync(stateFile, 'utf8'), original);
    authCode = 0;
    global.__syncProgress = { running: true };
    assert.equal((await request('/api/sync', 'POST')).status, 409);
    assert.equal(fs.readFileSync(stateFile, 'utf8'), original);
    delete global.__syncProgress;
    await new Promise((resolve) => server.close(resolve));
    server = createViewerServer();
    await listen();
    assert.equal(
        (await request('/api/sync-status')).body.lastSuccessfulSyncAt,
        success.body.lastSuccessfulSyncAt
    );
    fs.writeFileSync(stateFile, '{"lastSuccessfulSyncAt":"2020-01-01T00:00:00.000Z"}');
    exitCode = 0;
    output = '完成！\n';
    const noNew = await request('/api/sync', 'POST');
    assert.equal(noNew.body.ok, true);
    assert.equal(noNew.body.archived, 0);
    assert.equal(
        (await request('/api/sync-status')).body.lastSuccessfulSyncAt,
        noNew.body.lastSuccessfulSyncAt
    );
    fs.writeFileSync(stateFile, '{broken');
    assert.equal((await request('/api/sync-status')).status, 500);
    fs.unlinkSync(stateFile);
    fs.mkdirSync(stateFile);
    const unsaved = await request('/api/sync', 'POST');
    assert.equal(unsaved.body.ok, true);
    assert.equal(unsaved.body.syncTimeSaved, false);
    assert.ok(Number.isFinite(Date.parse(unsaved.body.lastSuccessfulSyncAt)));
});
