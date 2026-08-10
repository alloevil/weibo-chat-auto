const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const ls = require('../lib/live-sync.js');

// 实时同步的不变量。网络全部走注入的 fetchImpl（不碰真网），
// 落盘走真实临时目录（day-file 的原子写/去重必须真的生效）。

function tmpdir() {
    return fs.mkdtempSync(path.join(os.tmpdir(), 'live-sync-test-'));
}

/** 构造 webim 响应形状的假接口；每次调用返回 pages 里的下一页。 */
function fakeFetch(pages) {
    let i = 0;
    const calls = [];
    const impl = async (url) => {
        calls.push(url);
        const body = pages[Math.min(i++, pages.length - 1)];
        return { json: async () => body };
    };
    impl.calls = calls;
    return impl;
}

const raw = (id, tsSec, content = 'c' + id, user = 'u1') => ({
    id, time: tsSec, content, from_user: { screen_name: user },
});

// 2026-08-07 10:00:00 本地时间
const T0 = Math.floor(new Date(2026, 7, 7, 10, 0, 0).getTime() / 1000);

function mkGroup(dir) {
    return { name: 'G', groupId: '123', dir, seen: new Set(), primed: false };
}

test('fetchRecent: 标准化 + 按时间升序 + 透出 error_code', async () => {
    const impl = fakeFetch([{ messages: [raw(2, T0 + 5), raw(1, T0)] }]);
    const r = await ls.fetchRecent({ groupId: '123', cookieHeader: 'SUB=x', fetchImpl: impl });
    assert.strictEqual(r.errorCode, 0);
    assert.deepStrictEqual(r.messages.map(m => m.id), [1, 2]);
    // 与归档器同一套标准化：本地时区零填充时间 + YYYY-MM-DD
    assert.match(r.messages[0].time, /^\d{4}\/\d{2}\/\d{2} \d{2}:\d{2}:\d{2}$/);
    assert.match(r.messages[0].date, /^\d{4}-\d{2}-\d{2}$/);
    assert.strictEqual(r.messages[0].user, 'u1');
    // 请求形状：目标群 id + 不带分页游标（只要最近一页）
    assert.match(impl.calls[0], /[?&]id=123(&|$)/);
    assert.match(impl.calls[0], /[?&]max_mid=0(&|$)/);
});

test('fetchRecent: 未鉴权透出 21301', async () => {
    const r = await ls.fetchRecent({ groupId: '1', cookieHeader: '', fetchImpl: fakeFetch([{ error_code: 21301 }]) });
    assert.strictEqual(r.errorCode, 21301);
    assert.deepStrictEqual(r.messages, []);
});

test('pollGroupOnce: 首轮只建游标，绝不把历史当新消息广播', async () => {
    const dir = tmpdir();
    const g = mkGroup(dir);
    const impl = fakeFetch([{ messages: [raw(1, T0), raw(2, T0 + 1)] }]);

    const r = await ls.pollGroupOnce(g, { cookieHeader: () => 'SUB=x', fetchImpl: impl });
    assert.strictEqual(r.status, 'primed');
    assert.deepStrictEqual(r.newMessages, []);
    assert.strictEqual(g.seen.size, 2, '游标必须已建立');
    // 首轮不落盘：这些消息本就已在归档里
    assert.deepStrictEqual(fs.readdirSync(dir), []);
});

test('pollGroupOnce: 只广播真正新增，重复轮询幂等', async () => {
    const dir = tmpdir();
    const g = mkGroup(dir);
    const page1 = { messages: [raw(1, T0), raw(2, T0 + 1)] };
    const page2 = { messages: [raw(1, T0), raw(2, T0 + 1), raw(3, T0 + 2, '新消息')] };
    const impl = fakeFetch([page1, page2, page2]);

    await ls.pollGroupOnce(g, { cookieHeader: () => 'x', fetchImpl: impl });  // primed
    const r2 = await ls.pollGroupOnce(g, { cookieHeader: () => 'x', fetchImpl: impl });
    assert.strictEqual(r2.newMessages.length, 1);
    assert.strictEqual(r2.newMessages[0].content, '新消息');

    const r3 = await ls.pollGroupOnce(g, { cookieHeader: () => 'x', fetchImpl: impl });
    assert.deepStrictEqual(r3.newMessages, [], '同一页再来一轮不得重复广播');

    // 落盘：只写新增那条，且走 day-file（数组形态、含 timestamp）
    const file = path.join(dir, 'weibo_chat_' + r2.newMessages[0].date + '.json');
    const saved = JSON.parse(fs.readFileSync(file, 'utf-8'));
    assert.deepStrictEqual(saved.map(m => m.id), [3]);
});

test('pollGroupOnce: 跨日界的一轮增量分别落进各自日文件', async () => {
    const dir = tmpdir();
    const g = mkGroup(dir);
    const lateNight = Math.floor(new Date(2026, 7, 7, 23, 59, 30).getTime() / 1000);
    const afterMidnight = Math.floor(new Date(2026, 7, 8, 0, 0, 30).getTime() / 1000);
    const impl = fakeFetch([
        { messages: [raw(1, lateNight - 60)] },
        { messages: [raw(1, lateNight - 60), raw(2, lateNight), raw(3, afterMidnight)] },
    ]);

    await ls.pollGroupOnce(g, { cookieHeader: () => 'x', fetchImpl: impl });
    const r = await ls.pollGroupOnce(g, { cookieHeader: () => 'x', fetchImpl: impl });

    assert.deepStrictEqual(r.dates.sort(), ['2026-08-07', '2026-08-08']);
    assert.deepStrictEqual(fs.readdirSync(dir).sort(),
        ['weibo_chat_2026-08-07.json', 'weibo_chat_2026-08-08.json']);
});

test('pollGroupOnce: 21301 直接上报未鉴权，不落盘不广播', async () => {
    const dir = tmpdir();
    const g = mkGroup(dir);
    const r = await ls.pollGroupOnce(g, { cookieHeader: () => 'x', fetchImpl: fakeFetch([{ error_code: 21301 }]) });
    assert.strictEqual(r.status, 'unauthenticated');
    assert.deepStrictEqual(r.newMessages, []);
    assert.deepStrictEqual(fs.readdirSync(dir), []);
});

test('pollGroupOnce: 已见集有界，裁剪后仍不重播最近消息', async () => {
    const dir = tmpdir();
    const g = mkGroup(dir);
    // 一次灌入远超上限的消息
    const many = Array.from({ length: ls.SEEN_LIMIT + 50 }, (_, i) => raw(i + 1, T0 + i));
    const impl = fakeFetch([{ messages: many }, { messages: many.slice(-20) }]);

    await ls.pollGroupOnce(g, { cookieHeader: () => 'x', fetchImpl: impl });
    assert.ok(g.seen.size <= ls.SEEN_LIMIT, `已见集必须有界，实际 ${g.seen.size}`);

    // 裁剪砍掉的是最早的 id；最近 20 条仍在集合里，不会被当新消息
    const r = await ls.pollGroupOnce(g, { cookieHeader: () => 'x', fetchImpl: impl });
    assert.deepStrictEqual(r.newMessages, []);
});

test('createLiveSync: 订阅者进出控制轮询启停（没人看时不打接口）', async () => {
    const dir = tmpdir();
    const impl = fakeFetch([{ messages: [raw(1, T0)] }]);
    const live = ls.createLiveSync({
        resolveGroups: () => [{ name: 'G', groupId: '123', dir }],
        cookieHeader: () => 'x',
        emit: () => {},
        fetchImpl: impl,
        intervalMs: 60000,
    });

    assert.strictEqual(live.running, false, '没有订阅者时不得轮询');
    live.addSubscriber();
    assert.strictEqual(live.running, true);
    live.addSubscriber();
    live.removeSubscriber();
    assert.strictEqual(live.running, true, '还有订阅者时应继续轮询');
    live.removeSubscriber();
    assert.strictEqual(live.running, false, '最后一个订阅者离开必须停掉');
    live.stop();
});

test('createLiveSync: 跳过没有 groupId 的群，单群失败不影响其它群', async () => {
    const dir = tmpdir();
    const events = [];
    let calls = 0;
    const live = ls.createLiveSync({
        resolveGroups: () => [
            { name: '无ID群', groupId: '', dir },        // 归档器还没解析出会话 id
            { name: '炸群', groupId: '900', dir },
            { name: '好群', groupId: '901', dir },
        ],
        cookieHeader: () => 'x',
        emit: (e) => events.push(e),
        intervalMs: 60000,
        fetchImpl: async (url) => {
            calls++;
            if (url.includes('id=900')) throw new Error('boom');
            return { json: async () => ({ messages: [raw(7, T0)] }) };
        },
    });

    await live.tick();
    assert.strictEqual(calls, 2, '无 groupId 的群不得发起请求');
    assert.deepStrictEqual(events.map(e => [e.type, e.group]), [['error', '炸群']]);
    // 好群第一轮 primed（不广播），第二轮才可能有新消息 —— 关键是它确实被轮询到了
    live.stop();
});

test('createLiveSync: 未鉴权时停止轮询并上报 auth 事件', async () => {
    const dir = tmpdir();
    const events = [];
    const live = ls.createLiveSync({
        resolveGroups: () => [{ name: 'G', groupId: '1', dir }],
        cookieHeader: () => 'x',
        emit: (e) => events.push(e),
        intervalMs: 60000,
        fetchImpl: fakeFetch([{ error_code: 21301 }]),
    });
    live.addSubscriber();       // 启动并立即跑一轮
    await live.tick();          // tick() 返回进行中那一轮的 promise
    assert.deepStrictEqual(events, [{ type: 'auth', ok: false }]);
    assert.strictEqual(live.running, false, 'Cookie 失效后继续轮询只是空转');
});

test('groupByDate: 按 date 分桶，缺 date 归入 unknown', () => {
    const byDate = ls.groupByDate([
        { id: 1, date: '2026-08-07' }, { id: 2, date: '2026-08-08' },
        { id: 3, date: '2026-08-07' }, { id: 4 },
    ]);
    assert.deepStrictEqual([...byDate.keys()].sort(), ['2026-08-07', '2026-08-08', 'unknown']);
    assert.deepStrictEqual(byDate.get('2026-08-07').map(m => m.id), [1, 3]);
});
test('createLiveSync: 开关关闭时一个请求都不发（保住原生客户端未读提示）', async () => {
    const dir = tmpdir();
    let calls = 0;
    let enabled = false;
    const live = ls.createLiveSync({
        resolveGroups: () => [{ name: 'G', groupId: '123', dir }],
        cookieHeader: () => 'x',
        emit: () => {},
        intervalMs: 60000,
        isEnabled: () => enabled,
        fetchImpl: async () => { calls++; return { json: async () => ({ messages: [raw(1, T0)] }) }; },
    });

    live.addSubscriber();
    await live.tick();
    assert.strictEqual(calls, 0, '关闭时轮询不得发起任何请求');
    assert.strictEqual(live.running, false, '关闭时不得起定时器');

    // 开关每轮重新求值：打开后 refresh() 立即起轮询，无需重启进程
    enabled = true;
    live.refresh();
    assert.strictEqual(live.running, true);
    await live.tick();
    assert.ok(calls > 0, '开启后应正常轮询');

    // 再关掉：定时器停、后续 tick 不再发请求
    enabled = false;
    live.refresh();
    assert.strictEqual(live.running, false);
    const before = calls;
    await live.tick();
    assert.strictEqual(calls, before, '关闭后 tick 必须是空操作');
    live.stop();
});

test('createLiveSync: 关闭时即使有订阅者也不启动轮询', () => {
    const live = ls.createLiveSync({
        resolveGroups: () => [{ name: 'G', groupId: '1', dir: tmpdir() }],
        cookieHeader: () => 'x',
        emit: () => {},
        isEnabled: () => false,
        fetchImpl: async () => { throw new Error('不该被调用'); },
    });
    live.addSubscriber();
    assert.strictEqual(live.running, false);
    live.stop();
});
// ── 突发回补 ──────────────────────────────────────────────────────
// 固定只拉最近一页会在突发时丢消息（实测茧房有 67 个 20 秒窗口超过 20 条）。
// 这里用"按 max_mid 分页的假接口"验证：整页都是新消息时必须继续往回翻。

/** 模拟真实接口的 max_mid 语义：返回比 max_mid 更老的最近 count 条（升序）。 */
function pagedFetch(allRaw, { count = 20 } = {}) {
    const asc = [...allRaw].sort((a, b) => a.id - b.id);
    const calls = [];
    const impl = async (url) => {
        const maxMid = Number(new URL(url).searchParams.get('max_mid')) || 0;
        calls.push(maxMid);
        const pool = maxMid ? asc.filter(m => m.id < maxMid) : asc;
        return { json: async () => ({ messages: pool.slice(-count) }) };
    };
    impl.calls = calls;
    return impl;
}

test('pollGroupOnce: 一轮涌入超过一页时回补，不丢中间的消息', async () => {
    const dir = tmpdir();
    const g = mkGroup(dir);

    // 先用最早的 5 条建游标
    const seedMsgs = Array.from({ length: 5 }, (_, i) => raw(i + 1, T0 + i));
    await ls.pollGroupOnce(g, { cookieHeader: () => 'x', fetchImpl: pagedFetch(seedMsgs) });
    assert.strictEqual(g.seen.size, 5);

    // 随后一口气来了 45 条（远超单页 20）—— 全部都得广播且落盘
    const allMsgs = Array.from({ length: 50 }, (_, i) => raw(i + 1, T0 + i));
    const impl = pagedFetch(allMsgs);
    const r = await ls.pollGroupOnce(g, { cookieHeader: () => 'x', fetchImpl: impl });

    assert.strictEqual(r.newMessages.length, 45, '45 条新消息一条都不能少');
    assert.deepStrictEqual(r.newMessages.map(m => m.id), allMsgs.slice(5).map(m => m.id),
        '必须按时间升序、且正是未见过的那 45 条');
    assert.strictEqual(r.caughtUp, true, '翻到与已见集重叠即算追上');
    assert.ok(impl.calls.length >= 3, `应多次翻页，实际 ${impl.calls.length} 次`);
    assert.strictEqual(impl.calls[0], 0, '第一页从最新拉起');
    assert.ok(impl.calls[1] > 0, '后续页必须带 max_mid 往回翻');

    // 落盘同样完整
    const saved = JSON.parse(fs.readFileSync(path.join(dir, `weibo_chat_${r.newMessages[0].date}.json`), 'utf-8'));
    assert.strictEqual(saved.length, 45);
});

test('pollGroupOnce: 回补有上限，撞上限时标记 truncated 而不是无限翻页', async () => {
    const dir = tmpdir();
    const g = mkGroup(dir);
    await ls.pollGroupOnce(g, { cookieHeader: () => 'x', fetchImpl: pagedFetch([raw(1, T0)]) });

    // 远超回补上限（5 页 × 20 条）的历史，且没有任何一条是已见过的
    const huge = Array.from({ length: 500 }, (_, i) => raw(i + 100, T0 + i));
    const impl = pagedFetch(huge);
    const r = await ls.pollGroupOnce(g, { cookieHeader: () => 'x', fetchImpl: impl });

    assert.strictEqual(impl.calls.length, ls.MAX_BACKFILL_PAGES, '必须在上限处停下');
    assert.strictEqual(r.newMessages.length, ls.MAX_BACKFILL_PAGES * 20);
    assert.strictEqual(r.truncated, true, '截断必须自报，剩下的留给全量归档补');
});

test('pollGroupOnce: 首轮不因整页皆新而回补（只建游标，翻一页即止）', async () => {
    const dir = tmpdir();
    const g = mkGroup(dir);
    const many = Array.from({ length: 200 }, (_, i) => raw(i + 1, T0 + i));
    const impl = pagedFetch(many);

    const r = await ls.pollGroupOnce(g, { cookieHeader: () => 'x', fetchImpl: impl });
    assert.strictEqual(r.status, 'primed');
    assert.strictEqual(impl.calls.length, 1, '首轮只为建游标，不该翻页');
    assert.strictEqual(g.seen.size, 20);
});

test('pollGroupOnce: 回补途中 max_mid 不推进也不死循环', async () => {
    const dir = tmpdir();
    const g = mkGroup(dir);
    g.primed = true;
    g.seen.add('999');   // 有游标但与返回内容无交集
    let calls = 0;
    // 无论 max_mid 是什么都返回同一页（模拟接口忽略游标）
    const impl = async () => { calls++; return { json: async () => ({ messages: [raw(7, T0)] }) }; };

    const r = await ls.pollGroupOnce(g, { cookieHeader: () => 'x', fetchImpl: impl });
    assert.ok(calls <= ls.MAX_BACKFILL_PAGES, `不得无限翻页，实际 ${calls} 次`);
    assert.strictEqual(r.newMessages.length, 1, '重复页不得重复入库');
});
