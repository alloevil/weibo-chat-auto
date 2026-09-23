const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');

const DATA_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'viewer-http-test-'));
process.env.WEIBO_DATA_ROOT = DATA_ROOT;
process.env.WEIBO_COOKIE_FILE = path.join(DATA_ROOT, 'cookies.json');
const { uniqueGroupKey } = require('../lib/group-storage');
const { readRegistry } = require('../lib/group-registry');
const { createViewerServer } = require('../scripts/viewer-server');

function listen(server) {
    return new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(0, '127.0.0.1', () => resolve(server.address().port));
    });
}

function close(server) {
    return new Promise((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
    });
}

function request(port, { path = '/', method = 'GET', body = '', headers = {} } = {}) {
    return new Promise((resolve, reject) => {
        const req = http.request(
            {
                hostname: '127.0.0.1',
                port,
                path,
                method,
                headers: {
                    ...(body
                        ? {
                              'Content-Type': 'application/json',
                              'Content-Length': Buffer.byteLength(body),
                          }
                        : {}),
                    ...headers,
                },
            },
            (res) => {
                let text = '';
                res.setEncoding('utf-8');
                res.on('data', (chunk) => (text += chunk));
                res.on('end', () => resolve({ status: res.statusCode, text }));
            }
        );
        req.on('error', reject);
        req.end(body);
    });
}

test('viewer HTTP 边界: Host、CSRF、JSON 400/413 契约', async (t) => {
    const names = ['项目🔥', '项目❤️'];
    fs.writeFileSync(
        path.join(DATA_ROOT, 'config.json'),
        JSON.stringify({ chromePath: '', groups: [] })
    );
    const sessions = names.map((name, index) => ({ name, id: String(100 + index) }));
    const server = createViewerServer({ groupSessions: sessions });
    const port = await listen(server);
    t.after(() => close(server));
    t.after(() => fs.rmSync(DATA_ROOT, { recursive: true, force: true }));

    const badHost = await request(port, {
        path: '/api/groups',
        headers: { Host: 'attacker.example' },
    });
    assert.strictEqual(badHost.status, 403);

    const csrf = await request(port, {
        path: '/api/request-login',
        method: 'POST',
        headers: { Origin: 'https://attacker.example', 'Sec-Fetch-Site': 'cross-site' },
    });
    assert.strictEqual(csrf.status, 403);

    const malformed = await request(port, {
        path: '/api/qa',
        method: 'POST',
        body: '{"broken"',
    });
    assert.strictEqual(malformed.status, 400);
    assert.match(JSON.parse(malformed.text).error, /参数解析失败/);

    const oversized = await request(port, {
        path: '/api/qa',
        method: 'POST',
        body: JSON.stringify({ question: 'x'.repeat(270 * 1024) }),
    });
    assert.strictEqual(oversized.status, 413);
    assert.match(JSON.parse(oversized.text).error, /262144 字节上限/);

    const valid = await request(port, {
        path: '/api/qa',
        method: 'POST',
        body: '{}',
    });
    assert.strictEqual(valid.status, 200);
    assert.match(JSON.parse(valid.text).error, /缺少 group 或 question/);

    const missingAi = JSON.parse((await request(port, { path: '/api/ai-config' })).text);
    assert.strictEqual(missingAi.configured, false);
    assert.deepStrictEqual(missingAi.missingFields, ['baseUrl', 'apiKey', 'model']);

    const qaWithoutAi = JSON.parse(
        (
            await request(port, {
                path: '/api/qa',
                method: 'POST',
                body: JSON.stringify({ group: 'missing-group', question: '今天聊了什么？' }),
            })
        ).text
    );
    assert.strictEqual(qaWithoutAi.code, 'AI_NOT_CONFIGURED');
    assert.deepStrictEqual(qaWithoutAi.missingFields, ['baseUrl', 'apiKey', 'model']);

    const summaryWithoutAi = JSON.parse(
        (
            await request(port, {
                path: '/api/summary?group=missing-group&date=2026-09-23',
            })
        ).text
    );
    assert.strictEqual(summaryWithoutAi.code, 'AI_NOT_CONFIGURED');
    assert.deepStrictEqual(summaryWithoutAi.missingFields, ['baseUrl', 'apiKey', 'model']);

    const incompleteAi = await request(port, {
        path: '/api/ai-config',
        method: 'POST',
        body: JSON.stringify({ baseUrl: 'https://api.example.com/v1', model: '' }),
    });
    assert.strictEqual(incompleteAi.status, 400);
    assert.deepStrictEqual(JSON.parse(incompleteAi.text).missingFields, ['apiKey', 'model']);

    const savedAi = await request(port, {
        path: '/api/ai-config',
        method: 'POST',
        body: JSON.stringify({
            baseUrl: 'https://api.example.com/v1',
            apiKey: 'test-secret-key',
            model: 'test-model',
        }),
    });
    assert.strictEqual(savedAi.status, 200);
    const configuredAi = JSON.parse((await request(port, { path: '/api/ai-config' })).text);
    assert.strictEqual(configuredAi.configured, true);
    assert.deepStrictEqual(configuredAi.missingFields, []);
    assert.notStrictEqual(configuredAi.config.apiKey, 'test-secret-key');

    const saveGroups = await request(port, {
        path: '/api/group-config',
        method: 'POST',
        body: JSON.stringify({ groups: names }),
    });
    assert.strictEqual(saveGroups.status, 200);
    assert.strictEqual(JSON.parse(saveGroups.text).ok, true);
    const registry = readRegistry(path.join(DATA_ROOT, 'state', 'group-registry.json'));
    assert.deepStrictEqual(
        registry.groups.map((group) => [group.groupName, group.groupId]),
        names.map((name, index) => [name, String(100 + index)])
    );

    const groups = await request(port, { path: '/api/groups' });
    const groupData = JSON.parse(groups.text);
    assert.strictEqual(groups.status, 200);
    assert.deepStrictEqual(
        groupData.groups.map((group) => [group.name, group.id, group.count]),
        names.map((name) => [name, uniqueGroupKey(name), 0])
    );
    assert.notStrictEqual(groupData.groups[0].id, groupData.groups[1].id);

    const live = JSON.parse((await request(port, { path: '/api/live-config' })).text);
    assert.deepStrictEqual(live.groups, names.map(uniqueGroupKey));
});
