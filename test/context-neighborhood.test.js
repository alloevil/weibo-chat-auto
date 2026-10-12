const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const html = fs.readFileSync(path.join(__dirname, '../viewer.html'), 'utf8');
const source = html.slice(
    html.indexOf('function contextDayMessages('),
    html.indexOf('async function openContext(')
);
const api = vm.createContext({});
vm.runInContext(source, api);
const normalize = (value) => JSON.parse(JSON.stringify(value));
const rows = (date, prefix, size) =>
    Array.from({ length: size }, (_, index) => ({ date, id: prefix + index, timestamp: index }));
const day = rows('2026-09-21', 'b', 15);
const previous = rows('2026-09-20', 'a', 15);
const counts = {
    '2026-09-18': 4,
    '2026-09-20': 15,
    '2026-09-21': 15,
    '2026-09-22': 0,
    '2026-09-24': 3,
};

test('上下文计划：午夜两端只补不足侧，使用最近非空归档日期', () => {
    const first = api.contextReadPlan(day, '2026-09-21', 'b0', counts);
    assert.deepEqual(normalize([first.before, first.after, first.previous, first.next]), [
        10,
        0,
        '2026-09-20',
        '2026-09-24',
    ]);
    assert.deepEqual(
        normalize(api.contextNeighborhood(first, previous).map((message) => message.id)),
        [...previous.slice(-10), ...day.slice(0, 11)].map((message) => message.id)
    );
    const last = api.contextReadPlan(previous, '2026-09-20', 'a14', counts);
    assert.deepEqual(normalize([last.before, last.after]), [0, 10]);
    assert.deepEqual(
        normalize(api.contextNeighborhood(last, [], day).map((message) => message.id)),
        [...previous.slice(4), ...day.slice(0, 10)].map((message) => message.id)
    );
});

test('上下文同日足量不需相邻日，缺焦点不获取内容', () => {
    const long = rows('2026-09-21', 'm', 30);
    const middle = api.contextReadPlan(long, '2026-09-21', 'm15', counts);
    assert.deepEqual(normalize([middle.before, middle.after]), [0, 0]);
    assert.equal(api.contextNeighborhood(middle, previous, day).length, 21);
    const missing = api.contextReadPlan(day, '2026-09-21', 'missing', counts);
    assert.equal(missing.index, -1);
    assert.equal(api.contextNeighborhood(missing).length, 0);
});

test('上下文按归档日筛选、排序去重，不混入邻日重复ID', () => {
    const input = [
        { id: 1, date: '2026-09-21', timestamp: 2 },
        { id: '1', date: '2026-09-21', timestamp: 2 },
        { id: '0', date: '2026-09-21', timestamp: 1 },
        { id: 'foreign', date: '2026-09-20', timestamp: 0 },
    ];
    assert.deepEqual(
        normalize(api.contextDayMessages(input, '2026-09-21').map((message) => message.id)),
        ['0', 1]
    );
    const plan = api.contextReadPlan(
        [{ id: 'same', date: '2026-09-21' }],
        '2026-09-21',
        'same',
        {}
    );
    assert.equal(api.contextNeighborhood(plan, [{ id: 'same', date: '2026-09-20' }]).length, 2);
});

test('上下文一份相邻日不足不伪造补足，无邻日与跨空日间隔明确', () => {
    const plan = api.contextReadPlan([day[0]], '2026-09-21', 'b0', {
        '2026-09-18': 1,
        '2026-09-21': 1,
    });
    assert.equal(plan.previous, '2026-09-18');
    assert.equal(plan.next, '');
    assert.equal(api.contextNeighborhood(plan, previous.slice(0, 1)).length, 2);
    assert.equal(api.contextDateGap('2026-09-18', '2026-09-21'), 3);
    assert.equal(api.contextDateGap('2026-09-30', '2026-10-01'), 1);
});

function sessionHarness() {
    const requests = [];
    const renders = [];
    const context = vm.createContext({
        ctxSession: null,
        ctxFocusId: null,
        currentGroup: 'synthetic',
        archiveRevision: 1,
        selectedDate: '2026-09-21',
        allMessages: [day[0]],
        dateCounts: { '2026-09-20': 15, '2026-09-21': 1, '2026-09-22': 15 },
        URLSearchParams,
        fetch: (url) => new Promise((resolve, reject) => requests.push({ url, resolve, reject })),
        renderContext: (session) =>
            renders.push({
                id: session.id,
                loading: session.loading,
                failed: [...session.failed],
                pending: [...session.pending],
                dates: [...session.cache.keys()],
            }),
    });
    vm.runInContext(
        html.slice(
            html.indexOf('function contextDayMessages('),
            html.indexOf('function isOverlaySidebar(')
        ),
        context
    );
    return { context, requests, renders };
}

test('上下文集成状态：先呈现本日、两侧各一请求，失败保留内容且显式重试不并发', async () => {
    const { context, requests, renders } = sessionHarness();
    const operation = context.openContext('b0');
    assert.equal(renders[0].loading, true);
    assert.deepEqual(renders[0].dates, ['2026-09-21']);
    assert.equal(requests.length, 2);
    assert.deepEqual(
        requests.map((request) =>
            Object.fromEntries(new URLSearchParams(request.url.split('?')[1]))
        ),
        [
            { date: '2026-09-20', group: 'synthetic' },
            { date: '2026-09-22', group: 'synthetic' },
        ]
    );
    requests[0].reject(new Error('offline'));
    requests[1].resolve({
        ok: true,
        json: async () => ({ messages: rows('2026-09-22', 'c', 15) }),
    });
    await operation;
    assert.equal(context.ctxSession.loading, false);
    assert.equal(context.ctxSession.cache.get('2026-09-21').length, 1);
    assert.equal(context.ctxSession.failed.has('2026-09-20'), true);
    const retry = context.retryContextDay('2026-09-20');
    context.retryContextDay('2026-09-20');
    assert.equal(requests.length, 3);
    requests[2].resolve({ ok: true, json: async () => ({ messages: [...previous, previous[0]] }) });
    await retry;
    assert.equal(context.ctxSession.cache.get('2026-09-20').length, 15);
    assert.equal(context.ctxSession.failed.size, 0);
});

test('上下文集成状态：切群/关闭会话后旧邻日返回不渲染', async () => {
    for (const change of ['group', 'close', 'revision']) {
        const { context, requests, renders } = sessionHarness();
        const operation = context.openContext('b0');
        if (change === 'group') context.currentGroup = 'other';
        if (change === 'close') context.ctxSession = null;
        if (change === 'revision') context.archiveRevision++;
        for (const request of requests)
            request.resolve({ ok: true, json: async () => ({ messages: previous }) });
        await operation;
        assert.equal(renders.length, 1);
    }
});

test('上下文集成状态：已有本日完整邻域不发送消息读取请求', async () => {
    const { context, requests } = sessionHarness();
    context.allMessages = rows('2026-09-21', 'm', 30);
    await context.openContext('m15');
    assert.equal(requests.length, 0);
    assert.equal(context.ctxSession.loading, false);
});

test('主动中断只可显式继续，重复点击不并发，成功清除中断标记', async () => {
    const { context, requests } = sessionHarness();
    const operation = context.openContext('b0');
    for (const request of requests)
        request.resolve({ ok: true, json: async () => ({ messages: [] }) });
    await operation;
    requests.length = 0;
    context.ctxSession.cache.delete('2026-09-20');
    context.ctxSession.interrupted.add('2026-09-20');
    await context.openContext('b0');
    assert.equal(requests.length, 0);
    assert.equal(context.ctxSession.failed.size, 0);
    const continued = context.continueContextDay('2026-09-20');
    context.continueContextDay('2026-09-20');
    context.retryContextDay('2026-09-20');
    assert.equal(requests.length, 1);
    assert.equal(context.ctxSession.loading, true);
    requests[0].resolve({ ok: true, json: async () => ({ messages: previous }) });
    await continued;
    assert.equal(context.ctxSession.interrupted.size, 0);
    assert.equal(context.ctxSession.failed.size, 0);
    assert.equal(context.ctxSession.cache.get('2026-09-20').length, 15);
});

test('继续请求HTTP错误转为真实failed，重试不误标中断且只能一次', async () => {
    const { context, requests } = sessionHarness();
    const operation = context.openContext('b0');
    for (const request of requests)
        request.resolve({ ok: true, json: async () => ({ messages: [] }) });
    await operation;
    requests.length = 0;
    context.ctxSession.interrupted.add('2026-09-20');
    const continued = context.continueContextDay('2026-09-20');
    requests[0].resolve({ ok: false, json: async () => ({ error: 'HTTP503' }) });
    await continued;
    assert.equal(context.ctxSession.interrupted.has('2026-09-20'), false);
    assert.equal(context.ctxSession.failed.has('2026-09-20'), true);
    context.continueContextDay('2026-09-20');
    assert.equal(requests.length, 1);
    const retried = context.retryContextDay('2026-09-20');
    context.retryContextDay('2026-09-20');
    assert.equal(requests.length, 2);
    requests[1].resolve({ ok: true, json: async () => ({ messages: previous }) });
    await retried;
    assert.equal(context.ctxSession.failed.size, 0);
});
