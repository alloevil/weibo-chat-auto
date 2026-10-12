const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

test('真实普通搜索HTTP：组合契约、全历史候选、空条件免扫描、错误400、分页和旧q', async () => {
    const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'combined-http-'));
    process.env.WEIBO_DATA_ROOT = dataRoot;
    process.env.WEIBO_OUTPUT_DIR = path.join(dataRoot, 'output');
    process.env.WEIBO_COOKIE_FILE = path.join(dataRoot, 'cookies.json');
    const directory = path.join(dataRoot, 'output', 'synthetic');
    fs.mkdirSync(directory, { recursive: true });
    const messages = Array.from({ length: 135 }, (_, index) => ({
        id: String(index),
        date: '2026-09-20',
        from_uid: 'one',
        user: '同名',
        content: '部署验证后考虑回滚',
        timestamp: index,
    }));
    messages.push({
        id: 'other',
        date: '2026-09-20',
        from_uid: 'two',
        user: '同名',
        content: '部署 回滚',
    });
    messages.push({ ...messages[0] });
    fs.writeFileSync(path.join(directory, 'weibo_chat_2026-09-20.json'), JSON.stringify(messages));
    fs.writeFileSync(
        path.join(directory, 'weibo_chat_2026-09-22.json'),
        JSON.stringify([
            {
                id: 'latest',
                date: '2026-09-22',
                from_uid: 'new',
                user: '当日成员',
                content: '其他',
            },
        ])
    );
    const store = require('../lib/load-messages');
    const load = store.loadMessages;
    let scans = 0;
    store.loadMessages = (...args) => {
        scans++;
        return load(...args);
    };
    const { createViewerServer } = require('../scripts/viewer-server');
    const server = createViewerServer();
    try {
        await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
        const get = async (route, params) => {
            const response = await fetch(
                `http://127.0.0.1:${server.address().port}${route}?${new URLSearchParams({ group: 'synthetic', ...params })}`
            );
            return { status: response.status, data: await response.json() };
        };
        const empty = await get('/api/search', { mode: 'combined' });
        assert.equal(empty.data.total, 0);
        assert.equal(scans, 0);
        for (const dateFrom of ['2026-02-30', '2026-09-23']) {
            const invalid = await get('/api/search', {
                mode: 'combined',
                dateFrom,
                dateTo: '2026-09-22',
            });
            assert.equal(invalid.status, 400);
            assert.equal(invalid.data.ok, false);
            assert.equal(scans, 0);
        }
        const params = {
            mode: 'combined',
            fromUid: 'one',
            dateFrom: '2026-09-20',
            dateTo: '2026-09-20',
            keywords: '回滚 部署',
            limit: '60',
        };
        const ids = [];
        for (const offset of [0, 60, 120]) {
            const result = await get('/api/search', { ...params, offset: String(offset) });
            assert.equal(result.status, 200);
            assert.equal(result.data.total, 135);
            assert.deepEqual(result.data.byDate, [{ date: '2026-09-20', count: 135 }]);
            assert.equal(result.data.hits.length, offset === 120 ? 15 : 60);
            assert.equal(result.data.truncated, offset !== 120);
            ids.push(...result.data.hits.map((hit) => hit.id));
        }
        assert.equal(new Set(ids).size, 135);
        const legacy = await get('/api/search', { q: '部署 回滚', fromUid: 'one' });
        assert.deepEqual(
            legacy.data.hits.map((hit) => hit.id),
            ['other']
        );
        const members = await get('/api/search-members', {});
        assert.deepEqual(members.data.members.map((member) => member.id).sort(), [
            'new',
            'one',
            'two',
        ]);
        assert.equal(members.data.unidentifiedMessages, 0);
        assert.equal((await get('/api/search', { ...params, group: 'missing' })).data.total, 0);
    } finally {
        store.loadMessages = load;
        await new Promise((resolve) => server.close(resolve));
        fs.rmSync(dataRoot, { recursive: true, force: true });
    }
});
