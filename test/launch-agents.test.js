const { test } = require('node:test');
const assert = require('node:assert');
const la = require('../lib/launch-agents.js');

// 这组测试锁住一个真实事故：/api/schedule 只认一个 label，而实际在跑的是
// 历史遗留的另一个（日历触发每天 04:00）。界面因此显示"定时: 关闭"，任务却
// 照跑，归档读取消息清掉了微博客户端的未读提示。

const plist = ({ label = 'com.allo.weibo-archive', interval, hours, script = 'auto-archive-simple.js' } = {}) => `<?xml version="1.0" encoding="UTF-8"?>
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>${label}</string>
    <key>ProgramArguments</key>
    <array>
        <string>/opt/homebrew/bin/node</string>
        <string>/Users/allo/weibo-chat-auto/${script}</string>
    </array>
    ${interval != null ? `<key>StartInterval</key>\n<integer>${interval}</integer>` : ''}
    ${hours ? `<key>StartCalendarInterval</key>\n<array>${hours.map(h => `<dict><key>Hour</key><integer>${h}</integer><key>Minute</key><integer>0</integer></dict>`).join('')}</array>` : ''}
</dict>
</plist>`;

test('parsePlist: 读出 label 与 StartInterval', () => {
    const p = la.parsePlist(plist({ label: 'com.allo.weibo-chat-archive', interval: 3600 }));
    assert.strictEqual(p.label, 'com.allo.weibo-chat-archive');
    assert.strictEqual(p.interval, 3600);
    assert.deepStrictEqual(p.calendarHours, []);
    assert.strictEqual(p.targetsArchive, true);
});

test('parsePlist: 读出日历触发的小时（历史遗留任务就是这种）', () => {
    const p = la.parsePlist(plist({ hours: [4] }));
    assert.strictEqual(p.interval, 0, '日历触发没有 StartInterval —— 旧代码的正则因此匹配不上');
    assert.deepStrictEqual(p.calendarHours, [4]);
});

test('parsePlist: 多个日历触发点全部收集', () => {
    assert.deepStrictEqual(la.parsePlist(plist({ hours: [4, 12, 20] })).calendarHours, [4, 12, 20]);
});

test('parsePlist: 不指向本项目归档器的任务不认领', () => {
    const p = la.parsePlist(plist({ label: 'com.other.thing', interval: 60, script: 'something-else.js' }));
    assert.strictEqual(p.targetsArchive, false);
});

test('parsePlist: 空输入不抛错', () => {
    const p = la.parsePlist('');
    assert.deepStrictEqual([p.label, p.interval, p.calendarHours, p.targetsArchive], [null, 0, [], false]);
});

test('describeSchedule: 人话描述，界面据此显示真实状态', () => {
    assert.strictEqual(la.describeSchedule({ interval: 0, calendarHours: [4] }), '每天 04:00');
    assert.strictEqual(la.describeSchedule({ interval: 0, calendarHours: [20, 4] }), '每天 04:00、20:00');
    assert.strictEqual(la.describeSchedule({ interval: 3600, calendarHours: [] }), '每 1 小时');
    assert.strictEqual(la.describeSchedule({ interval: 1800, calendarHours: [] }), '每 30 分钟');
    assert.strictEqual(la.describeSchedule({ interval: 45, calendarHours: [] }), '每 45 秒');
    assert.strictEqual(la.describeSchedule({ interval: 0, calendarHours: [] }), '未设置触发条件');
});

test('findArchiveAgents: 认领所有指向归档器的任务，不管 label 叫什么', () => {
    const files = {
        'com.allo.weibo-archive.plist': plist({ label: 'com.allo.weibo-archive', hours: [4] }),
        'com.allo.weibo-chat-archive.plist': plist({ label: 'com.allo.weibo-chat-archive', interval: 3600 }),
        'com.spotify.helper.plist': plist({ label: 'com.spotify.helper', interval: 60, script: 'spotify.js' }),
        'notes.txt': 'not a plist',
    };
    const agents = la.findArchiveAgents('/agents', {
        readdirSync: () => Object.keys(files),
        readFileSync: (p) => files[p.split('/').pop()],
    });

    assert.deepStrictEqual(agents.map(a => a.label).sort(),
        ['com.allo.weibo-archive', 'com.allo.weibo-chat-archive'],
        '两个 label 都要认领 —— 只认一个正是那次事故的根因');
    assert.strictEqual(agents.find(a => a.label === 'com.allo.weibo-archive').calendarHours[0], 4);
    assert.ok(!agents.some(a => a.label.includes('spotify')), '别人的任务不能碰');
});

test('findArchiveAgents: 目录不存在或文件读失败时安全跳过', () => {
    assert.deepStrictEqual(la.findArchiveAgents('/nope', { readdirSync: () => { throw new Error('ENOENT'); }, readFileSync: () => '' }), []);
    const agents = la.findArchiveAgents('/agents', {
        readdirSync: () => ['a.plist', 'b.plist'],
        readFileSync: (p) => { if (p.endsWith('a.plist')) throw new Error('EACCES'); return plist({ label: 'ok', interval: 60 }); },
    });
    assert.deepStrictEqual(agents.map(a => a.label), ['ok']);
});
