// 相对日期表达 → 具体日期区间。
//
// 为什么要有这一层:原先「上周」「最近」这些表达只在 system prompt 里以文字
// 说明("上周 = 上一个完整周(周一到周日)"),由 LLM 自己算成 dateFrom/dateTo。
// 结果是算错就静默搜错范围——README 的历史 benchmark 里记着一次:问「上周分享
// 过什么链接」,Legacy 模式搜了 6/8-14 而正确答案在 6/15-21。
//
// 顺带修掉一个更隐蔽的 bug:提示词原先用 new Date().toISOString() 取"今天",
// 那是 UTC 日期,而归档消息的 time 字段("2026/09/08 07:00:00")是本地时间。
// UTC+8 时区在每天 00:00-08:00 之间,提示词说的"今天"比归档里的今天早一天,
// "昨天/最近 7 天"跟着一起偏。本模块全部走本地日期字段(getFullYear 等)。
//
// 参考:Chronos(arXiv 2603.16862)把相对时间表达在索引/检索侧解析成结构化
// datetime 区间,而非交给模型从字符串推断——其消融显示去掉日期过滤掉 14.7 分。
'use strict';

/** Date → 本地时区的 YYYY-MM-DD(不能用 toISOString,那是 UTC)。 */
function localDate(d) {
    const pad = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function addDays(d, n) {
    const out = new Date(d.getTime());
    out.setDate(out.getDate() + n);
    return out;
}

/** 周一为一周之始(中文语境);返回该日期所在周的周一。 */
function startOfWeek(d) {
    const day = d.getDay(); // 0=周日
    const backToMonday = day === 0 ? 6 : day - 1;
    return addDays(d, -backToMonday);
}

/**
 * 解析相对日期表达。
 *
 * 刻意只认高频、无歧义的表达。像「前几天」「最近一段时间」这种边界模糊的
 * 一律不认——猜错范围比不解析更有害(模型至少能从 dateSpan 里自己挑)。
 *
 * @param {string} text 用户原始问题
 * @param {Date} [now] 参照时刻,默认当前;测试用来固定时间
 * @returns {{dateFrom:string, dateTo:string, label:string}|null}
 */
function resolveRelativeRange(text, now = new Date()) {
    const q = String(text ?? '');
    const today = localDate(now);

    // 顺序有讲究:「上上周」必须先于「上周」,「前天」先于「天」
    // 「大前天」先于「前天」,否则前缀会被短模式吞掉。
    if (/大前天/.test(q)) {
        const d = localDate(addDays(now, -3));
        return { dateFrom: d, dateTo: d, label: '大前天' };
    }
    if (/前天/.test(q)) {
        const d = localDate(addDays(now, -2));
        return { dateFrom: d, dateTo: d, label: '前天' };
    }
    if (/昨天|昨日/.test(q)) {
        const d = localDate(addDays(now, -1));
        return { dateFrom: d, dateTo: d, label: '昨天' };
    }
    if (/今天|今日/.test(q)) {
        return { dateFrom: today, dateTo: today, label: '今天' };
    }
    if (/上上周|上上个?星期/.test(q)) {
        const monday = addDays(startOfWeek(now), -14);
        return {
            dateFrom: localDate(monday),
            dateTo: localDate(addDays(monday, 6)),
            label: '上上周(周一至周日)',
        };
    }
    if (/上周|上个?星期|上礼拜/.test(q)) {
        const monday = addDays(startOfWeek(now), -7);
        return {
            dateFrom: localDate(monday),
            dateTo: localDate(addDays(monday, 6)),
            label: '上周(周一至周日)',
        };
    }
    if (/本周|这周|这个?星期|这礼拜/.test(q)) {
        // 本周截止到今天,不含未来日期(归档里也没有)
        return { dateFrom: localDate(startOfWeek(now)), dateTo: today, label: '本周至今' };
    }
    if (/上个?月/.test(q)) {
        const first = new Date(now.getFullYear(), now.getMonth() - 1, 1);
        const last = new Date(now.getFullYear(), now.getMonth(), 0); // 上月最后一天
        return { dateFrom: localDate(first), dateTo: localDate(last), label: '上个月' };
    }
    if (/这个?月|本月/.test(q)) {
        const first = new Date(now.getFullYear(), now.getMonth(), 1);
        return { dateFrom: localDate(first), dateTo: today, label: '本月至今' };
    }
    // 「最近 N 天」优先于笼统的「最近」
    const nDays = q.match(/最近\s*(\d{1,3})\s*天/);
    if (nDays) {
        const n = Math.min(Math.max(Number(nDays[1]), 1), 365);
        return {
            dateFrom: localDate(addDays(now, -(n - 1))),
            dateTo: today,
            label: `最近 ${n} 天`,
        };
    }
    if (/最近|近期|这几天|这两天/.test(q)) {
        return { dateFrom: localDate(addDays(now, -6)), dateTo: today, label: '最近 7 天' };
    }
    return null;
}

/**
 * 给 system prompt 用的时间锚点。全部本地日期,与归档 time 字段同一口径。
 */
function timeAnchors(now = new Date()) {
    const lastWeekMonday = addDays(startOfWeek(now), -7);
    return {
        today: localDate(now),
        yesterday: localDate(addDays(now, -1)),
        dayBeforeYesterday: localDate(addDays(now, -2)),
        recentFrom: localDate(addDays(now, -6)),
        lastWeekFrom: localDate(lastWeekMonday),
        lastWeekTo: localDate(addDays(lastWeekMonday, 6)),
        thisWeekFrom: localDate(startOfWeek(now)),
    };
}

module.exports = { resolveRelativeRange, timeAnchors, localDate, startOfWeek, addDays };
