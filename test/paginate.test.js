const { test } = require('node:test');
const assert = require('node:assert');
const { paginateMessages } = require('../lib/paginate.js');
const { normalizeMessage } = require('../lib/normalize-message.js');

// 秒级 time 的原始 API 消息（接口按新→旧返回，每页第一条最旧 —— 与真实
// query_messages.json 一致：msgList[0] 是该页最旧的一条，翻页用它当 max_mid）
const raw = (id, timeSec) => ({ id, time: timeSec, from_user: { screen_name: 'u' + id }, content: 'c' + id });

// 造一个按 max_mid 翻页的假接口：pages 是 [ [最旧…最新], … ] 的页序列
function fakeFetch(pages) {
    const calls = [];
    return {
        calls,
        fetchPage: async (url) => {
            calls.push(url);
            const maxMid = url.match(/max_mid=(\w+)/)[1];
            const idx = maxMid === '0' ? 0
                : pages.findIndex(p => String(p[0]?.id) === maxMid) + 1;
            return { status: 200, data: { messages: pages[idx] ?? [] } };
        },
    };
}

const noSleep = () => Promise.resolve();
const quiet = () => {};

test('分页完整：多页走到底，paginationComplete=true，跨页去重', async () => {
    const pages = [
        [raw(30, 3000), raw(40, 4000)],
        [raw(10, 1000), raw(20, 2000), raw(30, 3000)], // 30 与上一页重叠 → 去重
        [],
    ];
    const { fetchPage } = fakeFetch(pages);
    const r = await paginateMessages({
        groupId: '123', stopTimestamp: 0, fetchPage,
        normalize: normalizeMessage, sleep: noSleep, log: quiet,
    });
    assert.strictEqual(r.paginationComplete, true);
    assert.deepStrictEqual(r.messages.map(m => m.id).sort((a, b) => a - b), [10, 20, 30, 40]);
    assert.strictEqual(r.messages.filter(m => m.id === 30).length, 1, '跨页重复必须去重');
});

test('中断后续传：从 state 的 stopTimestamp 恢复，到达截止即停且不翻后页', async () => {
    // 上次归档截止 2500s：第一页(最旧 3000s)未到截止继续翻，
    // 第二页最旧 2000s < 截止 → 停止，且不再请求第三页
    const pages = [
        [raw(30, 3000), raw(40, 4000)],
        [raw(20, 2000)],
        [raw(10, 1000)],
    ];
    const { fetchPage, calls } = fakeFetch(pages);
    const r = await paginateMessages({
        groupId: '123', stopTimestamp: 2500 * 1000, fetchPage,
        normalize: normalizeMessage, sleep: noSleep, log: quiet,
    });
    assert.strictEqual(r.paginationComplete, true, '到达截止时间算走完');
    assert.strictEqual(calls.length, 2, '到截止后不得继续翻页');
    // 截止页的消息也已收下（补齐到断点，交给 day-file 去重）
    assert.deepStrictEqual(r.messages.map(m => m.id).sort((a, b) => a - b), [20, 30, 40]);
});

test('截止边界：页面最旧消息恰等于 stopTimestamp 时不算越过，继续翻页', async () => {
    const pages = [
        [raw(20, 2000), raw(30, 3000)],
        [],
    ];
    const { fetchPage, calls } = fakeFetch(pages);
    const r = await paginateMessages({
        groupId: '123', stopTimestamp: 2000 * 1000, fetchPage, // pageOldestTs === stopTimestamp
        normalize: normalizeMessage, sleep: noSleep, log: quiet,
    });
    assert.strictEqual(r.paginationComplete, true);
    assert.strictEqual(calls.length, 2, '等于截止（< 不成立）应继续翻到无更多消息');
});

test('请求失败：分页残缺，paginationComplete=false 且带原因（state 不得推进）', async () => {
    const fetchPage = async () => { throw new Error('HTTP 500'); };
    const r = await paginateMessages({
        groupId: '123', stopTimestamp: 0, fetchPage,
        normalize: normalizeMessage, sleep: noSleep, log: quiet,
    });
    assert.strictEqual(r.paginationComplete, false);
    assert.match(r.paginationNote, /请求失败: HTTP 500/);
});

test('接口 error_code：识别为失败而不是"无更多消息"', async () => {
    const fetchPage = async () => ({ status: 200, data: { error_code: 21332, error: 'group not found' } });
    const r = await paginateMessages({
        groupId: '123', stopTimestamp: 0, fetchPage,
        normalize: normalizeMessage, sleep: noSleep, log: quiet,
    });
    assert.strictEqual(r.paginationComplete, false, 'error_code 不是走完');
    assert.match(r.paginationNote, /接口错误 21332/);
    assert.strictEqual(r.messages.length, 0);
});

test('撞上 maxPages：残缺并注明原因', async () => {
    let n = 0;
    const fetchPage = async () => {
        n++;
        return { status: 200, data: { messages: [raw(n, n * 1000)] } };
    };
    const r = await paginateMessages({
        groupId: '123', stopTimestamp: 0, fetchPage,
        normalize: normalizeMessage, sleep: noSleep, log: quiet, maxPages: 3,
    });
    assert.strictEqual(r.paginationComplete, false);
    assert.match(r.paginationNote, /MAX_PAGES=3/);
    assert.strictEqual(r.messages.length, 3);
});

test('翻页游标：max_mid 用每页第一条 id 推进；重复游标视为分页结束', async () => {
    const page = [raw(50, 5000), raw(60, 6000)];
    let n = 0;
    const urls = [];
    const fetchPage = async (url) => {
        urls.push(url);
        n++;
        return { status: 200, data: { messages: page } }; // 永远同一页 → 游标不动
    };
    const r = await paginateMessages({
        groupId: '123', stopTimestamp: 0, fetchPage,
        normalize: normalizeMessage, sleep: noSleep, log: quiet,
    });
    assert.strictEqual(n, 2, '第二页发现 firstId === maxMid 即结束');
    assert.strictEqual(r.paginationComplete, true);
    assert.match(urls[0], /max_mid=0/);
    assert.match(urls[1], /max_mid=50/);
});

test('onPage 落盘回调：每页收到本页新增（去重后）的消息', async () => {
    const pages = [
        [raw(30, 3000), raw(40, 4000)],
        [raw(10, 1000), raw(30, 3000)],
        [],
    ];
    const { fetchPage } = fakeFetch(pages);
    const batches = [];
    await paginateMessages({
        groupId: '123', stopTimestamp: 0, fetchPage,
        normalize: normalizeMessage, sleep: noSleep, log: quiet,
        onPage: (batch, { pageNum }) => batches.push({ pageNum, ids: batch.map(m => m.id) }),
    });
    assert.deepStrictEqual(batches, [
        { pageNum: 0, ids: [30, 40] },
        { pageNum: 1, ids: [10] }, // 30 已见过，不重复交给落盘
    ]);
});
