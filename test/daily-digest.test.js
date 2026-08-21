const { test } = require('node:test');
const assert = require('node:assert');
const { createDailyDigest, digestExcerpt, FAIL_RETRY_MS } = require('../lib/daily-digest.js');

// 注入式 harness：mock 摘要生成与通知投递，状态存内存
function makeHarness(overrides = {}) {
    const calls = { generate: [], notify: [] };
    let state = {};
    const deps = {
        getConfig: () => ({ enabled: true }),
        hasAiConfig: () => true,
        listGroups: () => ['群A'],
        countMessages: () => 5,
        generateSummary: async (group, date) => {
            calls.generate.push([group, date]);
            return { ok: true, summary: '## 话题一\n讨论了正事' };
        },
        notify: (group, notifications) => calls.notify.push([group, notifications]),
        isArchiverRunning: () => false,
        loadState: () => state,
        saveState: (s) => { state = JSON.parse(JSON.stringify(s)); },
        nowDate: () => new Date('2026-08-21T21:00:00'),
        ...overrides,
    };
    return { digest: createDailyDigest(deps), calls, getState: () => state };
}

test('开关关闭（默认）：零额外行为，不生成不通知', async () => {
    const h = makeHarness({ getConfig: () => ({ enabled: false }) });
    const r = await h.digest.check();
    assert.strictEqual(r.skipped, 'disabled');
    assert.strictEqual(h.calls.generate.length, 0);
    assert.strictEqual(h.calls.notify.length, 0);
});

test('未配置 AI：完全不打扰（不生成不通知）', async () => {
    const h = makeHarness({ hasAiConfig: () => false });
    const r = await h.digest.check();
    assert.strictEqual(r.skipped, 'no-ai');
    assert.strictEqual(h.calls.generate.length, 0);
    assert.strictEqual(h.calls.notify.length, 0);
});

test('当日无新消息：跳过该群，不生成不通知', async () => {
    const h = makeHarness({ countMessages: () => 0 });
    const r = await h.digest.check();
    assert.deepStrictEqual(r.generated, []);
    assert.strictEqual(h.calls.generate.length, 0);
    assert.strictEqual(h.calls.notify.length, 0);
});

test('未到摘要时点（默认 20 点）不触发', async () => {
    const h = makeHarness({ nowDate: () => new Date('2026-08-21T14:00:00') });
    const r = await h.digest.check();
    assert.strictEqual(r.skipped, 'too-early');
    assert.strictEqual(h.calls.generate.length, 0);
});

test('归档器进行中不触发（跑完再摘要）', async () => {
    const h = makeHarness({ isArchiverRunning: () => true });
    const r = await h.digest.check();
    assert.strictEqual(r.skipped, 'archiving');
    assert.strictEqual(h.calls.generate.length, 0);
});

test('满足全部条件：生成摘要并通知一次，同日不重复', async () => {
    const h = makeHarness();
    const r1 = await h.digest.check();
    assert.deepStrictEqual(r1.generated, ['群A']);
    assert.deepStrictEqual(h.calls.generate, [['群A', '2026-08-21']]);
    assert.strictEqual(h.calls.notify.length, 1);
    const [group, notifications] = h.calls.notify[0];
    assert.strictEqual(group, '群A');
    assert.strictEqual(notifications[0].kind, 'summary');
    assert.strictEqual(notifications[0].date, '2026-08-21');
    assert.match(notifications[0].title, /群A/);
    assert.match(notifications[0].body, /讨论了正事/);
    // 状态先落盘再通知
    assert.strictEqual(h.getState().digested['群A'], '2026-08-21');
    // 同日再查：不再生成
    const r2 = await h.digest.check();
    assert.deepStrictEqual(r2.generated, []);
    assert.strictEqual(h.calls.generate.length, 1);
    assert.strictEqual(h.calls.notify.length, 1);
});

test('跨日后重新生成（去重按日期）', async () => {
    let now = new Date('2026-08-21T21:00:00');
    const h = makeHarness({ nowDate: () => now });
    await h.digest.check();
    now = new Date('2026-08-22T21:00:00');
    const r = await h.digest.check();
    assert.deepStrictEqual(r.generated, ['群A']);
    assert.deepStrictEqual(h.calls.generate[1], ['群A', '2026-08-22']);
});

test('生成失败：不通知不落状态，30 分钟内不重试，之后重试', async () => {
    let now = new Date('2026-08-21T21:00:00');
    let fail = true;
    const h = makeHarness({
        nowDate: () => now,
        generateSummary: async (group, date) => {
            h.calls.generate.push([group, date]);
            return fail ? { ok: false, error: 'LLM 超时' } : { ok: true, summary: 'ok' };
        },
    });
    await h.digest.check();
    assert.strictEqual(h.calls.notify.length, 0);
    assert.strictEqual(h.getState().digested?.['群A'], undefined);
    // 30 分钟内：不重试
    now = new Date(now.getTime() + FAIL_RETRY_MS - 1000);
    fail = false;
    await h.digest.check();
    assert.strictEqual(h.calls.generate.length, 1);
    // 超过 30 分钟：重试成功并通知
    now = new Date(now.getTime() + 2000);
    const r = await h.digest.check();
    assert.deepStrictEqual(r.generated, ['群A']);
    assert.strictEqual(h.calls.notify.length, 1);
});

test('多群：只为有消息的群生成，各自独立去重', async () => {
    const h = makeHarness({
        listGroups: () => ['群A', '群B', '群C'],
        countMessages: (g) => (g === '群B' ? 0 : 3),
    });
    const r = await h.digest.check();
    assert.deepStrictEqual(r.generated, ['群A', '群C']);
    assert.strictEqual(h.calls.notify.length, 2);
});

test('自定义摘要时点 hour 生效', async () => {
    const h = makeHarness({
        getConfig: () => ({ enabled: true, hour: 22 }),
        nowDate: () => new Date('2026-08-21T21:00:00'),
    });
    assert.strictEqual((await h.digest.check()).skipped, 'too-early');
});

test('digestExcerpt: 去 markdown、压行、截断', () => {
    const s = digestExcerpt('## 话题一：**大事**\n\n> 引用\n正文', 30);
    assert.strictEqual(s.includes('#'), false);
    assert.strictEqual(s.includes('*'), false);
    assert.ok(s.length <= 30);
    assert.match(s, /话题一/);
});
