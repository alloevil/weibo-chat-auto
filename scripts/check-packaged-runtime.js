'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const { spawn, spawnSync } = require('node:child_process');
const { once } = require('node:events');
const { createHash } = require('node:crypto');

const option = (name) => process.argv[process.argv.indexOf(name) + 1];
const serverPath = option('--server');
const resources = option('--resources');
const artifacts = option('--artifacts');

async function main() {
    for (const name of ['--server', '--resources', '--artifacts']) {
        assert.ok(process.argv.includes(name) && option(name), `Required: ${name}`);
    }
    fs.mkdirSync(artifacts, { recursive: true });
    const data = fs.mkdtempSync(path.join(os.tmpdir(), 'weibo-packaged-data-'));
    const group = path.join(data, 'output', 'synthetic');
    fs.mkdirSync(group, { recursive: true });
    fs.writeFileSync(path.join(data, 'config.json'), JSON.stringify({ groups: ['synthetic'] }));
    const messages = Array.from({ length: 3 }, (_, index) => ({
        id: `target-${index}`,
        from_uid: 'member-one',
        user: '合成用户',
        content: '先部署验证，再考虑回滚。这是安装包合成验收消息。',
        date: '2026-10-12',
        time: `2026/10/12 10:0${index}:00`,
        timestamp: Date.parse('2026-10-12T10:00:00Z') + index * 60000,
    }));
    fs.writeFileSync(path.join(group, 'weibo_chat_2026-10-12.json'), JSON.stringify(messages));
    const worker = path.join(
        resources,
        `archive-worker${process.platform === 'win32' ? '.exe' : ''}`
    );
    const env = {
        ...process.env,
        PATH: '',
        WEIBO_RESOURCE_ROOT: resources,
        WEIBO_DATA_ROOT: data,
        WEIBO_OUTPUT_DIR: path.join(data, 'output'),
        WEIBO_COOKIE_FILE: path.join(data, 'cookies.json'),
        WEIBO_TASK_EXECUTABLE: worker,
        NO_OPEN: '1',
    };
    const probe = net.createServer();
    probe.listen(0, '127.0.0.1');
    await once(probe, 'listening');
    const port = probe.address().port;
    await new Promise((resolve) => probe.close(resolve));
    env.WEIBO_PORT = String(port);
    const child = spawn(serverPath, [], { cwd: data, env, stdio: ['ignore', 'pipe', 'pipe'] });
    let log = '';
    child.stdout.on('data', (chunk) => (log += chunk.toString()));
    child.stderr.on('data', (chunk) => (log += chunk.toString()));
    try {
        await new Promise((resolve, reject) => {
            const timeout = setTimeout(() => reject(new Error(`Not ready: ${log}`)), 10000);
            child.once('error', (error) => {
                clearTimeout(timeout);
                reject(error);
            });
            child.once('exit', (code) => {
                clearTimeout(timeout);
                reject(new Error(`Early exit ${code}: ${log}`));
            });
            child.stdout.on('data', () => {
                if (log.includes(`SIDECAR_READY ${port}`)) {
                    clearTimeout(timeout);
                    resolve();
                }
            });
        });
        const url = `http://127.0.0.1:${port}`;
        const request = async (route, options = {}) => {
            const response = await fetch(url + route, {
                ...options,
                signal: AbortSignal.timeout(10000),
            });
            assert.equal(response.status, 200, route);
            return response;
        };
        const html = await (
            await request('/', { headers: { 'User-Agent': 'WeiboChatDesktop/1.0' } })
        ).text();
        assert.ok(html.includes('window.__WEIBO_DESKTOP=true'));
        assert.equal(
            html.replace('<head><script>window.__WEIBO_DESKTOP=true;</script>', '<head>'),
            fs.readFileSync(path.join(resources, 'viewer.html'), 'utf8')
        );
        fs.writeFileSync(path.join(artifacts, 'homepage.html'), html);
        for (const file of ['lib/text-utils.js', 'lib/viewer-filters.js']) {
            const content = await (await request(`/${file}`)).text();
            assert.equal(content, fs.readFileSync(path.join(resources, file), 'utf8'));
        }
        const params = new URLSearchParams({
            group: 'synthetic',
            mode: 'combined',
            fromUid: 'member-one',
            dateFrom: '2026-10-12',
            dateTo: '2026-10-12',
            keywords: '回滚 部署',
        });
        const search = await (await request(`/api/search?${params}`)).json();
        assert.equal(search.total, 3);
        assert.deepEqual(
            search.hits.map((hit) => hit.id),
            ['target-2', 'target-1', 'target-0']
        );
        fs.writeFileSync(path.join(artifacts, 'search.json'), JSON.stringify(search, null, 2));
        const sync = await (await request('/api/sync', { method: 'POST' })).json();
        assert.equal(sync.needLogin, true);
        const archive = spawnSync(worker, ['archive'], {
            cwd: data,
            env,
            encoding: 'utf8',
            timeout: 10000,
        });
        fs.writeFileSync(path.join(artifacts, 'archive.log'), archive.stdout + archive.stderr);
        assert.equal(archive.status, 1, archive.stderr);
        assert.match(archive.stderr, /请先在应用内扫码登录/);
        const index = spawnSync(worker, ['index', '--group', 'synthetic', '--all'], {
            cwd: data,
            env,
            encoding: 'utf8',
            timeout: 10000,
        });
        fs.writeFileSync(path.join(artifacts, 'index.log'), index.stdout + index.stderr);
        assert.equal(index.status, 0, index.stderr);
        assert.match(index.stdout, /LLM 调用 0/);
        assert.equal((index.stdout.match(/\[index\] 完成:/g) || []).length, 1);
        assert.doesNotMatch(index.stdout, /SIDECAR_READY/);
        const storedIndex = JSON.parse(
            fs.readFileSync(path.join(group, 'qa-index/chunks_2026-10-12.json'), 'utf8')
        );
        assert.equal(storedIndex.sourceCount, 3);
        const configResponse = await request('/api/ai-config', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                baseUrl: 'http://127.0.0.1:1/v1',
                apiKey: 'synthetic-test-key',
                model: 'offline-placeholder',
            }),
        });
        const configResult = await configResponse.json();
        assert.equal(configResult.ok, true);
        assert.ok(fs.existsSync(path.join(data, 'ai-config.json')));
        for (const name of [
            'config.json',
            'cookies.json',
            'ai-config.json',
            'output',
            'state',
            'cache',
        ]) {
            assert.equal(
                fs.existsSync(path.join(resources, name)),
                false,
                `Resource write: ${name}`
            );
        }
        const result = {
            status: 'PASS',
            server: serverPath,
            resources,
            data,
            path: env.PATH,
            homepageBytes: Buffer.byteLength(html),
            homepageSha256: createHash('sha256').update(html).digest('hex'),
            searchIds: search.hits.map((hit) => hit.id),
            archiveExit: archive.status,
            indexExit: index.status,
            indexSourceCount: storedIndex.sourceCount,
            configWrittenInData: true,
        };
        fs.writeFileSync(path.join(artifacts, 'result.json'), JSON.stringify(result, null, 2));
        console.log(JSON.stringify(result, null, 2));
    } finally {
        if (child.exitCode === null && child.signalCode === null) {
            child.kill('SIGTERM');
            await once(child, 'exit');
        }
        fs.writeFileSync(path.join(artifacts, 'server.log'), log);
    }
}

main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
