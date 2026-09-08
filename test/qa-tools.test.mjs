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

// ─── 索引期别名改写（Chronos arXiv 2603.16862 的设计）────────────────────
function groupDirWithIndex(date, chunks) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qa-idx-'));
    fs.mkdirSync(path.join(dir, 'qa-index'), { recursive: true });
    return {
        dir,
        write: (msgs) => {
            const dayPath = path.join(dir, `weibo_chat_${date}.json`);
            fs.writeFileSync(dayPath, JSON.stringify({ messages: msgs }));
            const st = fs.statSync(dayPath);
            fs.writeFileSync(
                path.join(dir, 'qa-index', `chunks_${date}.json`),
                JSON.stringify({
                    version: 1,
                    date,
                    sourceMtime: st.mtimeMs,
                    sourceCount: msgs.length,
                    chunks,
                })
            );
        },
    };
}

test('别名让"完全不同词汇"的提问命中原文（不必靠 LLM 精排）', async () => {
    const msgs = [
        mkMsg(601, 0, 'tombkeeper', '我把手里的芯片股清了一半', '2026-07-01'),
        mkMsg(602, 2, 'alice', '这么果断', '2026-07-01'),
        mkMsg(603, 4, 'tombkeeper', '还没跌到位', '2026-07-01'),
        // 第二个块（40 分钟断层）——必须 >=2 块，否则走 searchFlat 兜底
        mkMsg(604, 46, 'carol', '推荐一下冲牙器', '2026-07-01'),
        mkMsg(605, 48, 'alice', '博皓不错', '2026-07-01'),
    ];
    const chunksNoAlias = [
        { seq: 0, key: 'k0', msgIds: [601, 602, 603], annotation: '话题:股票操作。', aliases: [] },
        { seq: 1, key: 'k1', msgIds: [604, 605], annotation: '话题:小家电。', aliases: [] },
    ];
    const chunksWithAlias = [
        {
            seq: 0,
            key: 'k0',
            msgIds: [601, 602, 603],
            annotation: '话题:股票操作。',
            aliases: ['减持半导体持仓', '调整投资仓位'],
        },
        {
            seq: 1,
            key: 'k1',
            msgIds: [604, 605],
            annotation: '话题:小家电。',
            aliases: ['口腔清洁设备'],
        },
    ];

    // 提问用词与原文零重叠："减持" / "投资" 都不在消息正文里
    const q = ['减持', '投资'];

    const a = groupDirWithIndex('2026-07-01', chunksNoAlias);
    a.write(msgs);
    const without = await executeTool(
        'search_messages',
        { keywords: q },
        msgs,
        ledger(),
        null,
        null,
        { groupDir: a.dir }
    );

    const b = groupDirWithIndex('2026-07-01', chunksWithAlias);
    b.write(msgs);
    const withAlias = await executeTool(
        'search_messages',
        { keywords: q },
        msgs,
        ledger(),
        null,
        null,
        { groupDir: b.dir }
    );

    // 无别名时词面无交集 → 该话题块拿不到分；有别名时命中
    assert.ok(
        withAlias.matchCount > 0 && withAlias.snippets.join('\n').includes('芯片股'),
        `别名应让"减持/投资"命中写着"芯片股"的块（实际 matchCount=${withAlias.matchCount}）`
    );
    assert.ok(
        (without.matchCount || 0) === 0 || !without.snippets.join('\n').includes('芯片股'),
        '无别名时不该命中（否则本用例证明不了别名的作用）'
    );
});

test('别名只进 BM25 打分，不出现在给模型看的片段里', async () => {
    const msgs = [
        mkMsg(701, 0, 'tombkeeper', '我把手里的芯片股清了一半', '2026-07-01'),
        mkMsg(702, 2, 'alice', '嗯', '2026-07-01'),
        mkMsg(703, 46, 'carol', '推荐一下冲牙器', '2026-07-01'),
        mkMsg(704, 48, 'alice', '博皓不错', '2026-07-01'),
    ];
    const chunks = [
        {
            seq: 0,
            key: 'k0',
            msgIds: [701, 702],
            annotation: '话题:股票操作。',
            aliases: ['减持半导体持仓', 'ALIASLEAKCANARY'],
        },
        { seq: 1, key: 'k1', msgIds: [703, 704], annotation: '话题:小家电。', aliases: [] },
    ];
    const g = groupDirWithIndex('2026-07-01', chunks);
    g.write(msgs);
    const r = await executeTool(
        'search_messages',
        { keywords: ['减持'] },
        msgs,
        ledger(),
        null,
        null,
        { groupDir: g.dir }
    );
    const shown = r.snippets.join('\n');
    assert.ok(r.matchCount > 0, '别名应命中');
    assert.ok(
        !shown.includes('ALIASLEAKCANARY'),
        '别名泄漏进片段会让模型以为群里有人这么说过，进而编造引文'
    );
    assert.ok(shown.includes('芯片股'), '真实原文仍在片段里');
});

test('旧索引无 aliases 字段时不崩溃（向后兼容）', async () => {
    const msgs = [
        mkMsg(801, 0, 'a', '半导体行情', '2026-07-01'),
        mkMsg(802, 2, 'b', '还没跌到位', '2026-07-01'),
        mkMsg(803, 46, 'c', '冲牙器推荐', '2026-07-01'),
        mkMsg(804, 48, 'd', '博皓不错', '2026-07-01'),
    ];
    // 注意：故意不写 aliases 字段，模拟本次改动之前生成的索引
    const chunks = [
        { seq: 0, key: 'k0', msgIds: [801, 802], annotation: '话题:半导体。' },
        { seq: 1, key: 'k1', msgIds: [803, 804], annotation: '话题:冲牙器。' },
    ];
    const g = groupDirWithIndex('2026-07-01', chunks);
    g.write(msgs);
    const r = await executeTool(
        'search_messages',
        { keywords: ['半导体'] },
        msgs,
        ledger(),
        null,
        null,
        { groupDir: g.dir }
    );
    assert.ok(r.matchCount > 0, '旧索引应照常工作');
});

// ─── 相对日期在工具侧解析（原先靠 LLM 自己算，算错就静默搜错范围）────────
// 语料：2026-09-01(周二) ~ 2026-09-08(周二)，每天一条可区分的消息
function dayMsgs() {
    const out = [];
    for (let d = 1; d <= 8; d++) {
        const ts = new Date(2026, 8, d, 10, 0, 0).getTime();
        out.push({
            id: String(9000 + d),
            user: 'alice',
            content: `第${d}天的话题 链接分享`,
            timestamp: ts,
            time: `2026/09/${String(d).padStart(2, '0')} 10:00:00`,
        });
    }
    return out;
}

test('get_recent_messages 省略日期时，从问题解析「上周」', async () => {
    // 用真实"今天"无法断言固定区间，所以断言的是「解析发生了」而非具体日期：
    // dateNote 出现即证明工具替模型限定了范围，dateRange 回报了实际区间
    const r = await executeTool(
        'get_recent_messages',
        {},
        dayMsgs(),
        ledger(),
        null,
        '上周分享过什么链接'
    );
    assert.ok(r.dateNote, '应回报自动限定的说明');
    assert.match(r.dateNote, /上周/);
    assert.match(r.dateNote, /\d{4}-\d{2}-\d{2} ~ \d{4}-\d{2}-\d{2}/, '说明里应含具体区间');
});

test('模型显式给的日期优先于问题里的相对表达', async () => {
    const r = await executeTool(
        'get_recent_messages',
        { dateFrom: '2026-09-03', dateTo: '2026-09-04' },
        dayMsgs(),
        ledger(),
        null,
        '上周分享过什么链接' // 问题说"上周"，但模型显式给了 9/3-9/4
    );
    assert.strictEqual(r.dateRange, '2026-09-03 ~ 2026-09-04');
    assert.strictEqual(r.dateNote, undefined, '显式传日期时不该自动覆盖');
    assert.strictEqual(r.total, 2, '应只读到 9/3 与 9/4 两条');
});

test('问题无相对表达时不限定范围（不猜）', async () => {
    const r = await executeTool(
        'get_recent_messages',
        {},
        dayMsgs(),
        ledger(),
        null,
        '谁在聊半导体'
    );
    assert.strictEqual(r.dateNote, undefined);
    assert.strictEqual(r.total, 8, '未解析出相对表达时应读全部');
});

test('search_messages 也走同一套日期解析', async () => {
    const r = await executeTool(
        'search_messages',
        { keywords: ['链接'] },
        dayMsgs(),
        ledger(),
        null,
        '昨天分享的链接'
    );
    // "昨天"必然落在语料外或内，两种都可接受；关键是解析发生并回报
    assert.ok(r.dateNote, 'search_messages 应同样回报自动限定');
    assert.match(r.dateNote, /昨天/);
});

test('count_messages 刻意不自动限定（它的用途是不限日期探测分布）', async () => {
    // 自动限定会破坏 system prompt 教的"先宽后窄"策略：
    // 先用 count_messages 探全量分布 → 再把 search_messages 锁到热点日期
    const r = await executeTool(
        'count_messages',
        { keywords: ['话题'] },
        dayMsgs(),
        ledger(),
        null,
        '上周聊了什么话题'
    );
    assert.strictEqual(r.dateNote, undefined, 'count_messages 不该自动限定');
    assert.strictEqual(r.total, 8, '应统计全部 8 天，而非只统计上周');
});

// ─── 媒体字段进检索 + 复读折叠 ──────────────────────────────────────────
function mkX(id, offsetMin, user, content, dateStr, extra = {}) {
    return { ...mkMsg(id, offsetMin, user, content, dateStr), ...extra };
}

test('链接的三种形态都可检索（share.url / link / videoUrl）', async () => {
    // 修复前：msgText 只拼 content + share.title，问「分享过什么链接」matchCount=0
    const msgs = [
        mkX(1001, 0, 'alice', '这个值得看', '2026-07-01', {
            share: { title: '台积电三季报', url: 'https://a.com/tsmc' },
        }),
        mkX(1002, 2, 'bob', '收到', '2026-07-01'),
        mkX(1003, 50, 'carol', '分享一下', '2026-07-01', { link: 'https://b.com/article' }),
        mkX(1004, 52, 'dave', '谢谢', '2026-07-01'),
        mkX(1005, 100, 'alice', '看视频', '2026-07-01', { videoUrl: 'https://v.com/1.mp4' }),
        mkX(1006, 102, 'bob', '好', '2026-07-01'),
    ];
    const link = await executeTool('search_messages', { keywords: ['链接'] }, msgs, ledger());
    assert.ok(link.matchCount > 0, '搜「链接」应命中 share.url 与 link 字段的消息');

    const video = await executeTool('search_messages', { keywords: ['视频'] }, msgs, ledger());
    assert.ok(video.matchCount > 0, '搜「视频」应命中 videoUrl 字段的消息');
});

test('图片消息可检索（原先 [图片xN] 只在展示层）', async () => {
    const msgs = [
        mkX(1101, 0, 'alice', '看图', '2026-07-01', { pics: ['a.jpg', 'b.jpg'] }),
        mkX(1102, 2, 'bob', '好', '2026-07-01'),
        mkX(1103, 50, 'carol', '别的事', '2026-07-01'),
        mkX(1104, 52, 'dave', '嗯', '2026-07-01'),
    ];
    const r = await executeTool('search_messages', { keywords: ['图片'] }, msgs, ledger());
    assert.ok(r.matchCount > 0, '搜「图片」应命中带 pics 的消息');
});

test('count_messages 与 search_messages 看同一份文本（含媒体字段）', async () => {
    const msgs = [
        mkX(1201, 0, 'alice', '看这个', '2026-07-01', {
            share: { title: 'x', url: 'https://a.com/1' },
        }),
        mkX(1202, 2, 'bob', '纯文本', '2026-07-01'),
    ];
    const c = await executeTool('count_messages', { keywords: ['链接'] }, msgs, ledger());
    assert.strictEqual(c.total, 1, 'count 也应看到链接标记，否则先探测后精搜口径不一致');
});

test('count_messages 的关键词不匹配发言人名（person 参数才做这件事）', async () => {
    // msgText 含 user 供 BM25 打分用；count 走 msgBody，不含 user
    const msgs = [
        mkMsg(1301, 0, 'zhangsan', '今天天气不错', '2026-07-01'),
        mkMsg(1302, 2, 'lisi', '是的', '2026-07-01'),
    ];
    const c = await executeTool('count_messages', { keywords: ['zhangsan'] }, msgs, ledger());
    assert.strictEqual(c.total, 0, '搜人名不该通过关键词命中该人的所有发言');
});

test('连续复读被折叠并标注次数，非连续重复保留', async () => {
    const msgs = [
        mkMsg(1401, 0, 'a', '半导体还没跌到位', '2026-07-01'),
        mkMsg(1402, 1, 'b', '半导体还没跌到位', '2026-07-01'), // 连续复读
        mkMsg(1403, 2, 'c', '半导体还没跌到位', '2026-07-01'), // 连续复读
        mkMsg(1404, 3, 'd', '我把芯片股清了一半 半导体估值没消化', '2026-07-01'),
        mkMsg(1405, 4, 'a', '半导体还没跌到位', '2026-07-01'), // 非连续，应保留
        mkMsg(1406, 60, 'x', '冲牙器推荐', '2026-07-01'),
        mkMsg(1407, 62, 'y', '博皓不错', '2026-07-01'),
    ];
    const r = await executeTool('search_messages', { keywords: ['半导体'] }, msgs, ledger());
    const text = r.snippets.join('\n');
    assert.match(text, /连续重复 3 次/, '三连复读应折叠为一行并标注次数');
    // 折叠后该句仍出现两次：折叠行 + 非连续的那条
    const occurrences = (text.match(/半导体还没跌到位/g) || []).length;
    assert.strictEqual(occurrences, 2, '非连续重复不该被合并（可能是不同语境的独立发言）');
    assert.match(text, /芯片股/, '有信息的消息仍在');
});

test('空内容消息（纯图片/分享）不参与复读折叠', async () => {
    // 它们的区别在媒体字段上，按 content 归一会把不同的分享合成一条
    const msgs = [
        mkX(1501, 0, 'a', '', '2026-07-01', { share: { title: 'A文', url: 'https://a.com' } }),
        mkX(1502, 1, 'b', '', '2026-07-01', { share: { title: 'B文', url: 'https://b.com' } }),
        mkMsg(1503, 50, 'c', '别的话题', '2026-07-01'),
        mkMsg(1504, 52, 'd', '嗯', '2026-07-01'),
    ];
    const r = await executeTool('search_messages', { keywords: ['链接'] }, msgs, ledger());
    const text = r.snippets.join('\n');
    assert.doesNotMatch(text, /连续重复/, '空内容消息不该被折叠');
});
