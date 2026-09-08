'use strict';

const { test } = require('node:test');
const assert = require('node:assert');

const {
    resolveRelativeRange,
    timeAnchors,
    localDate,
    startOfWeek,
} = require('../lib/relative-dates');

// 固定参照时刻：2026-09-08 是周二（用本地时区构造，与归档 time 字段同口径）
const TUE = new Date(2026, 8, 8, 14, 30, 0); // 月份 0-based：8 = 九月

test('localDate 用本地日期，不受 UTC 偏移影响', () => {
    // UTC+8 的早上 07:00，toISOString() 会退到前一天
    const morning = new Date(2026, 8, 8, 7, 0, 0);
    assert.strictEqual(localDate(morning), '2026-09-08');
});

test('startOfWeek 以周一为一周之始，周日归上一周', () => {
    assert.strictEqual(localDate(startOfWeek(new Date(2026, 8, 8))), '2026-09-07'); // 周二 → 周一
    assert.strictEqual(localDate(startOfWeek(new Date(2026, 8, 7))), '2026-09-07'); // 周一 → 自身
    assert.strictEqual(localDate(startOfWeek(new Date(2026, 8, 13))), '2026-09-07'); // 周日 → 本周一
});

test('昨天/前天/大前天/今天 解析为单日区间', () => {
    for (const [q, d] of [
        ['今天有人聊什么', '2026-09-08'],
        ['昨天有讨论投资吗', '2026-09-07'],
        ['前天说了什么', '2026-09-06'],
        ['大前天呢', '2026-09-05'],
    ]) {
        const r = resolveRelativeRange(q, TUE);
        assert.deepStrictEqual(
            [r.dateFrom, r.dateTo],
            [d, d],
            `${q} 应解析为 ${d}，实际 ${r && r.dateFrom}`
        );
    }
});

test('上周 = 上一个完整周（周一到周日）—— 这是历史 benchmark 里搜错的那个', () => {
    const r = resolveRelativeRange('上周分享过什么链接', TUE);
    assert.strictEqual(r.dateFrom, '2026-08-31'); // 上周一
    assert.strictEqual(r.dateTo, '2026-09-06'); // 上周日
    assert.match(r.label, /上周/);
});

test('上上周不被「上周」前缀吞掉', () => {
    const r = resolveRelativeRange('上上周聊了什么', TUE);
    assert.strictEqual(r.dateFrom, '2026-08-24');
    assert.strictEqual(r.dateTo, '2026-08-30');
});

test('本周至今不包含未来日期', () => {
    const r = resolveRelativeRange('这周大家在聊什么', TUE);
    assert.strictEqual(r.dateFrom, '2026-09-07'); // 本周一
    assert.strictEqual(r.dateTo, '2026-09-08'); // 今天，而非本周日
});

test('最近 = 7 天含今天；最近 N 天优先于笼统的「最近」', () => {
    const r = resolveRelativeRange('最近大家在聊什么话题', TUE);
    assert.strictEqual(r.dateFrom, '2026-09-02'); // 含今天共 7 天
    assert.strictEqual(r.dateTo, '2026-09-08');

    const n = resolveRelativeRange('最近3天有什么事', TUE);
    assert.strictEqual(n.dateFrom, '2026-09-06');
    assert.strictEqual(n.dateTo, '2026-09-08');
    assert.match(n.label, /3 天/);
});

test('上个月跨月边界正确（含当月天数不同的情况）', () => {
    const r = resolveRelativeRange('上个月聊了什么', TUE);
    assert.strictEqual(r.dateFrom, '2026-08-01');
    assert.strictEqual(r.dateTo, '2026-08-31');

    // 3 月 5 日问「上个月」应得 2 月，且 2026 非闰年 → 28 日
    const mar = resolveRelativeRange('上个月呢', new Date(2026, 2, 5));
    assert.strictEqual(mar.dateFrom, '2026-02-01');
    assert.strictEqual(mar.dateTo, '2026-02-28');

    // 1 月问「上个月」应跨年到去年 12 月
    const jan = resolveRelativeRange('上个月呢', new Date(2026, 0, 10));
    assert.strictEqual(jan.dateFrom, '2025-12-01');
    assert.strictEqual(jan.dateTo, '2025-12-31');
});

test('边界模糊或无相对表达时返回 null（不猜）', () => {
    // 猜错范围比不解析更有害：不解析时模型还能从 dateSpan 自己挑
    for (const q of ['谁在聊半导体', '前几天的事', 'tk 说了什么', '']) {
        assert.strictEqual(resolveRelativeRange(q, TUE), null, `"${q}" 不该被解析`);
    }
});

test('timeAnchors 全部为本地日期，上周区间与 resolveRelativeRange 一致', () => {
    const a = timeAnchors(TUE);
    assert.strictEqual(a.today, '2026-09-08');
    assert.strictEqual(a.yesterday, '2026-09-07');
    assert.strictEqual(a.dayBeforeYesterday, '2026-09-06');
    assert.strictEqual(a.recentFrom, '2026-09-02');

    const r = resolveRelativeRange('上周', TUE);
    assert.strictEqual(a.lastWeekFrom, r.dateFrom);
    assert.strictEqual(a.lastWeekTo, r.dateTo);
});

test('清晨时段的锚点不偏移一天（UTC 偏移回归）', () => {
    // 这是修复前的真实 bug：toISOString() 在 UTC+8 的 00:00-08:00 会退一天
    const dawn = new Date(2026, 8, 8, 3, 0, 0);
    const a = timeAnchors(dawn);
    assert.strictEqual(a.today, '2026-09-08', '凌晨 3 点的"今天"仍应是 09-08');
    assert.strictEqual(a.yesterday, '2026-09-07');
});
