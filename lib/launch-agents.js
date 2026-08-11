// launchd 定时归档任务的发现与解析（macOS）。
//
// 为什么不按 label 硬编码：/api/schedule 原先只认 'com.allo.weibo-chat-archive'，
// 而实际在跑的是历史 setup.sh 留下的 'com.allo.weibo-archive'（日历触发每天
// 04:00）。于是界面显示"定时: 关闭"，任务却每天半夜照跑 —— 用户以为关着，
// 归档读取消息把微博客户端的未读提示清掉了。实测踩过。
//
// 改为按"plist 的程序参数是否指向 auto-archive-simple.js"来发现，label 叫什么
// 都能纳管；解析是纯函数，便于测试。
'use strict';

const ARCHIVE_SCRIPT = 'auto-archive-simple.js';

/**
 * 解析 launchd plist（只取本模块关心的字段）。
 * @returns {{label: string|null, interval: number, calendarHours: number[], targetsArchive: boolean}}
 */
function parsePlist(xml) {
    const text = String(xml || '');
    const label = (text.match(/<key>Label<\/key>\s*<string>([^<]+)<\/string>/) || [])[1] || null;
    const interval = Number((text.match(/<key>StartInterval<\/key>\s*<integer>(\d+)<\/integer>/) || [])[1] || 0);

    // 日历触发可以有多条（<array> 里多个 <dict>），把所有 Hour 都收集起来
    const calendarHours = [];
    if (/<key>StartCalendarInterval<\/key>/.test(text)) {
        const after = text.slice(text.indexOf('StartCalendarInterval'));
        for (const m of after.matchAll(/<key>Hour<\/key>\s*<integer>(\d+)<\/integer>/g)) {
            calendarHours.push(Number(m[1]));
        }
    }

    return {
        label,
        interval: Number.isFinite(interval) ? interval : 0,
        calendarHours,
        targetsArchive: text.includes(ARCHIVE_SCRIPT),
    };
}

/** 人类可读的调度说明（供界面显示真实状态，而不是只显示一个下拉值）。 */
function describeSchedule({ interval, calendarHours }) {
    if (calendarHours && calendarHours.length > 0) {
        return `每天 ${calendarHours.slice().sort((a, b) => a - b).map(h => `${String(h).padStart(2, '0')}:00`).join('、')}`;
    }
    if (interval > 0) {
        if (interval % 3600 === 0) return `每 ${interval / 3600} 小时`;
        if (interval % 60 === 0) return `每 ${interval / 60} 分钟`;
        return `每 ${interval} 秒`;
    }
    return '未设置触发条件';
}

/**
 * 在 LaunchAgents 目录里找出所有指向本项目归档器的任务。
 * fs 通过参数注入，便于测试。
 * @returns {Array<{file: string, label: string, interval: number, calendarHours: number[]}>}
 */
function findArchiveAgents(dir, { readdirSync, readFileSync }) {
    let names;
    try {
        names = readdirSync(dir);
    } catch {
        return [];
    }
    const out = [];
    for (const name of names) {
        if (!name.endsWith('.plist')) continue;
        let xml;
        try {
            xml = readFileSync(`${dir}/${name}`, 'utf-8');
        } catch {
            continue;
        }
        const p = parsePlist(xml);
        if (!p.targetsArchive || !p.label) continue;
        out.push({ file: `${dir}/${name}`, label: p.label, interval: p.interval, calendarHours: p.calendarHours });
    }
    return out;
}

module.exports = { parsePlist, describeSchedule, findArchiveAgents, ARCHIVE_SCRIPT };
