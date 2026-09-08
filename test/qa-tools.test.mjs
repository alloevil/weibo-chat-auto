import { test } from 'node:test';
import assert from 'node:assert';
import { executeTool, expandContext } from '../scripts/qa-agent.mjs';

// 合成消息:两天,两个发言人,含 30 分钟以上时间断层
const T0 = new Date('2026-07-01T10:00:00+08:00').getTime();
const MIN = 60000;
function mkMsg(id, offsetMin, user, content, dateStr) {
    const ts = T0 + offsetMin * MIN;
    const d = new Date(ts);
    const pad = (n) => String(n).padStart(2, '0');
    return {
        id,
        user,
        content,
        timestamp: ts,
        time: `${dateStr.replace(/-/g, '/')} ${pad(d.getHours())}:${pad(d.getMinutes())}:00`,
    };
}
const MSGS = [
    mkMsg(1, 0, 'alice', '今天聊聊半导体行情', '2026-07-01'),
    mkMsg(2, 2, 'bob', '半导体还没跌到位', '2026-07-01'),
    mkMsg(3, 4, 'alice', '那黄金呢', '2026-07-01'),
    mkMsg(4, 6, 'bob', '黄金主因是央行增持', '2026-07-01'),
    // 40 分钟断层 → 新话题
    mkMsg(5, 46, 'carol', '推荐一下冲牙器', '2026-07-01'),
    mkMsg(6, 48, 'alice', '博皓不错,别买小米', '2026-07-01'),
    // 次日
    mkMsg(7, 24 * 60, 'bob', '今天 A 股大涨', '2026-07-02'),
    mkMsg(8, 24 * 60 + 2, 'carol', '巨化股份涨停了', '2026-07-02'),
];

function ledger() {
    return {
        facts: [],
        searchHistory: [],
        citations: [],
        totalMatches: 0,
        dateRangeUsed: null,
        confidence: 'low',
    };
}

test('count_messages: 按日期直方图,关键词包含匹配', async () => {
    const r = await executeTool('count_messages', { keywords: ['半导体'] }, MSGS, ledger());
    assert.strictEqual(r.total, 2);
    assert.deepStrictEqual(r.groups, [{ key: '2026-07-01', count: 2 }]);
    assert.strictEqual(r.dateSpan.first, '2026-07-01');
    assert.strictEqual(r.dateSpan.last, '2026-07-02');
});

test('count_messages: 无关键词统计纯消息量,person 过滤', async () => {
    const r = await executeTool('count_messages', { person: 'bob' }, MSGS, ledger());
    assert.strictEqual(r.total, 3);
    const r2 = await executeTool('count_messages', { person: '不存在的人' }, MSGS, ledger());
    assert.strictEqual(r2.total, MSGS.length);
    assert.match(r2.personNote, /未找到发言人/);
});

test('count_messages: 零命中给 hint,日期格式非法给示例', async () => {
    const r = await executeTool('count_messages', { keywords: ['不存在词xyz'] }, MSGS, ledger());
    assert.strictEqual(r.total, 0);
    assert.match(r.hint, /换更短的词/);
    const bad = await executeTool('count_messages', { dateFrom: '2026/07/01' }, MSGS, ledger());
    assert.match(bad.error, /YYYY-MM-DD/);
});

test('get_context: 按 id 定位,时间断层截断上下文', async () => {
    const led = ledger();
    const r = await executeTool('get_context', { messageId: '2' }, MSGS, led);
    assert.strictEqual(r.found, true);
    // 40 分钟断层:话题一(1-4)不应包含话题二(5-6)
    assert.strictEqual(r.range.count, 4);
    assert.ok(r.messages.every((m) => !m.includes('冲牙器')));
    // citations 覆盖整个返回窗口(4 条),而非只记锚点——答案可能引用窗口内
    // 任意一句，只记锚点会让真正被引用的内容漏出引用池
    assert.strictEqual(led.citations.length, 4);
    assert.deepStrictEqual(
        led.citations.map((c) => c.id),
        [1, 2, 3, 4]
    );
});

test('get_context: id 不存在返回可操作 hint', async () => {
    const r = await executeTool('get_context', { messageId: '999' }, MSGS, ledger());
    assert.strictEqual(r.found, false);
    assert.match(r.hint, /hitIds/);
});

test('search_messages: 命中返回 hitIds(含 id/user/date/preview)', async () => {
    const led = ledger();
    const r = await executeTool('search_messages', { keywords: ['半导体'] }, MSGS, led);
    assert.ok(r.matchCount > 0);
    assert.strictEqual(r.matchUnit, 'topic_chunk'); // 无 groupDir 时即时切块,仍走块级
    assert.ok(Array.isArray(r.hitIds) && r.hitIds.length > 0);
    const hit = r.hitIds[0];
    assert.ok(hit.id != null && hit.user && hit.date && typeof hit.preview === 'string');
    // 引用指向真正命中的消息(半导体在 id 1/2),而不是块首
    assert.ok(r.hitIds.every((h) => [1, 2].includes(h.id)));
    assert.ok(led.citations.length > 0);
});

test('search_messages: 离线标注跨过词汇鸿沟(annotation 参与 BM25)', async () => {
    const fs = await import('node:fs');
    const os = await import('node:os');
    const path = await import('node:path');
    const { chunkKey } = await import('../lib/chat-chunks.js').then((m) => m.default || m);
    const { clearIndexCache } = await import('../lib/chunk-index.js').then((m) => m.default || m);

    clearIndexCache();
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qa-chunk-search-'));
    fs.mkdirSync(path.join(dir, 'qa-index'));
    const day1 = MSGS.filter((m) => m.time.startsWith('2026/07/01'));
    const dayPath = path.join(dir, 'weibo_chat_2026-07-01.json');
    fs.writeFileSync(dayPath, JSON.stringify(day1));
    const mtime = fs.statSync(dayPath).mtimeMs;
    const mkChunk = (seq, msgIds, annotation) => ({
        seq,
        msgIds,
        annotation,
        key: chunkKey({ msgIds }),
        startTs: 0,
        endTs: MSGS.find((m) => m.id === msgIds[msgIds.length - 1]).timestamp,
        users: [],
    });
    fs.writeFileSync(
        path.join(dir, 'qa-index', 'chunks_2026-07-01.json'),
        JSON.stringify({
            version: 1,
            date: '2026-07-01',
            sourceMtime: mtime,
            sourceCount: day1.length,
            chunks: [
                mkChunk(0, [1, 2, 3, 4], null),
                mkChunk(1, [5, 6], '话题:口腔护理与冲牙器选购推荐。结论:博皓可选,避开小米。'),
            ],
        })
    );

    // "口腔护理"只出现在标注里,消息原文没有——无标注时搜不到
    const r = await executeTool(
        'search_messages',
        { keywords: ['口腔护理'] },
        MSGS,
        ledger(),
        null,
        null,
        { groupDir: dir }
    );
    assert.strictEqual(r.matchUnit, 'topic_chunk');
    assert.ok(r.matchCount > 0);
    assert.ok(r.hitIds.some((h) => [5, 6].includes(h.id)));
    assert.ok(r.snippets[0].includes('【话题标注】'));
});

test('search_messages: 关键词零命中给拆词建议,person 零匹配给 personNote', async () => {
    const r = await executeTool(
        'search_messages',
        { keywords: ['量子计算机套件'], person: '路人甲' },
        MSGS,
        ledger()
    );
    assert.strictEqual(r.matchCount, 0);
    assert.strictEqual(r.totalInRange, MSGS.length);
    assert.match(r.hint, /拆成 2 字短词/);
    assert.match(r.personNote, /未找到发言人/);
});

test('search_messages: 日期范围外零消息时提示可用范围', async () => {
    const r = await executeTool(
        'search_messages',
        { keywords: ['半导体'], dateFrom: '2027-01-01', dateTo: '2027-01-02' },
        MSGS,
        ledger()
    );
    assert.strictEqual(r.matchCount, 0);
    assert.match(r.hint, /可用的日期范围是 2026-07-01 ~ 2026-07-02/);
});

test('get_recent_messages: 日期过滤与越界提示', async () => {
    const r = await executeTool(
        'get_recent_messages',
        { dateFrom: '2026-07-02', dateTo: '2026-07-02' },
        MSGS,
        ledger()
    );
    assert.strictEqual(r.total, 2);
    const empty = await executeTool(
        'get_recent_messages',
        { dateFrom: '2025-01-01', dateTo: '2025-01-02' },
        MSGS,
        ledger()
    );
    assert.match(empty.hint, /可用的日期范围/);
});

test('search_messages: keywords 传成字符串时归一为数组(模型常犯)', async () => {
    const r = await executeTool('search_messages', { keywords: '半导体' }, MSGS, ledger());
    assert.ok(r.matchCount > 0);
    const r2 = await executeTool('count_messages', { keywords: '半导体' }, MSGS, ledger());
    assert.strictEqual(r2.total, 2);
});

test('搜索/统计对数字 user 字段不崩溃', async () => {
    const withNumUser = [
        ...MSGS,
        { ...mkMsg(9, 100, 'x', '半导体测试', '2026-07-01'), user: 8225980033 },
    ];
    const r = await executeTool(
        'search_messages',
        { keywords: ['半导体'], person: 'alice' },
        withNumUser,
        ledger()
    );
    assert.ok(r.matchCount >= 0);
    const r2 = await executeTool('count_messages', { person: '8225' }, withNumUser, ledger());
    assert.strictEqual(r2.total, 1);
});

test('expandContext: 断层两侧不跨越', () => {
    const [start, end] = expandContext(MSGS, 4); // 消息5(冲牙器)
    assert.strictEqual(start, 4);
    assert.strictEqual(end, 6);
});

// ─── 别名解析 + 噪音过滤接入检索 ────────────────────────────────────────
import fs from 'fs';
import os from 'os';
import path from 'path';

function groupDirWith(aliases) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qa-alias-'));
    fs.writeFileSync(path.join(dir, 'aliases.json'), JSON.stringify(aliases));
    return dir;
}

test('别名让 person 过滤命中真名(替代模型自己猜 tk → tombkeeper)', async () => {
    const msgs = [
        mkMsg(101, 0, 'tombkeeper', '半导体还没跌到位', '2026-07-01'),
        mkMsg(102, 2, 'alice', '我觉得会反弹', '2026-07-01'),
        mkMsg(103, 4, 'tombkeeper', '芯片股我清了一半', '2026-07-01'),
    ];
    const groupDir = groupDirWith({ tombkeeper: ['tk'] });

    // 无别名表:person="tk" 匹配不到任何 user，退回全量并给 personNote
    const without = await executeTool('count_messages', { person: 'tk' }, msgs, ledger());
    assert.strictEqual(without.total, 3, '无别名时退回全量');
    assert.match(without.personNote, /未找到发言人/);

    // 有别名表:精确筛到 tombkeeper 的 2 条
    const withAlias = await executeTool(
        'count_messages',
        { person: 'tk' },
        msgs,
        ledger(),
        null,
        null,
        { groupDir }
    );
    assert.strictEqual(withAlias.total, 2, '别名命中后只算 tombkeeper');
    assert.match(withAlias.personNote, /已解析为/);
});

test('别名同时扩进 BM25 查询,搜得到只提真名的消息', async () => {
    const msgs = [
        mkMsg(201, 0, 'alice', 'tombkeeper 昨天那个判断很准', '2026-07-01'),
        mkMsg(202, 2, 'alice', '今天天气不错', '2026-07-01'),
        mkMsg(203, 4, 'bob', '同意', '2026-07-01'),
        mkMsg(204, 6, 'bob', '随便说点别的', '2026-07-01'),
    ];
    const groupDir = groupDirWith({ tombkeeper: ['tk'] });
    // 关键词只给别名 tk;正文里写的是 tombkeeper
    const r = await executeTool(
        'search_messages',
        { keywords: ['tk'], person: 'tk' },
        msgs,
        ledger(),
        null,
        null,
        { groupDir }
    );
    assert.ok(r.matchCount > 0, '别名扩展后应命中提到 tombkeeper 的消息');
    assert.ok(r.snippets.join('\n').includes('tombkeeper'), '片段里应出现真名那条');
});

test('噪音消息不进检索:红包/签到不再稀释话题', async () => {
    const msgs = [
        mkMsg(301, 0, 'bot', '收到红包消息', '2026-07-01'),
        mkMsg(302, 1, 'bot', '还没签到的快去看看,群聊等级加速', '2026-07-01'),
        mkMsg(303, 2, 'alice', '半导体行情怎么看', '2026-07-01'),
        mkMsg(304, 3, 'bob', '半导体还没跌到位', '2026-07-01'),
    ];
    const all = await executeTool('count_messages', {}, msgs, ledger());
    assert.strictEqual(all.total, 2, '两条噪音应被剔除');

    const r = await executeTool(
        'get_recent_messages',
        {
            dateFrom: '2026-07-01',
            dateTo: '2026-07-01',
        },
        msgs,
        ledger()
    );
    const text = r.messages.join('\n');
    assert.ok(!text.includes('收到红包'), '总结型读取不应看到红包');
    assert.ok(!text.includes('签到'), '总结型读取不应看到签到机器人');
    assert.ok(text.includes('半导体'), '真实话题仍在');
});

test('全是噪音时退回原语料,而不是谎报无人发言', async () => {
    const msgs = [
        mkMsg(401, 0, 'bot', '收到红包消息', '2026-07-01'),
        mkMsg(402, 1, 'bot', '最佳手气', '2026-07-01'),
    ];
    const r = await executeTool(
        'get_recent_messages',
        {
            dateFrom: '2026-07-01',
            dateTo: '2026-07-01',
        },
        msgs,
        ledger()
    );
    assert.strictEqual(r.total, 2, '不应变成 0 条');
});

test('get_context 仍能按 id 拉到噪音相邻的上下文(id 不因过滤失效)', async () => {
    const msgs = [
        mkMsg(501, 0, 'alice', '半导体行情怎么看', '2026-07-01'),
        mkMsg(502, 1, 'bot', '收到红包消息', '2026-07-01'),
        mkMsg(503, 2, 'bob', '还没跌到位', '2026-07-01'),
    ];
    const r = await executeTool('get_context', { messageId: '502' }, msgs, ledger());
    assert.strictEqual(r.found, true, 'get_context 必须走全量语料');
});
