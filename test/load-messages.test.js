const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const ms = require('../lib/load-messages.js');

test('loadMessages/loadMessagesByDate: 数字 user 归一为字符串', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'load-messages-test-'));
    fs.writeFileSync(path.join(dir, 'weibo_chat_2026-07-01.json'), JSON.stringify([
        { id: 1, user: 8225980033, timestamp: 1000, time: '2026/07/01 10:00:00', date: '2026-07-01', content: 'x' },
        { id: 2, user: 'alice', timestamp: 2000, time: '2026/07/01 10:00:01', date: '2026-07-01', content: 'y' },
        { id: 3, timestamp: 3000, time: '2026/07/01 10:00:02', date: '2026-07-01', content: 'z' }, // 无 user
    ]));

    const all = ms.loadMessages(dir, '');
    assert.deepStrictEqual(all.map(m => m.user), ['8225980033', 'alice', '']);
    assert.ok(all.every(m => typeof m.user === 'string'));

    const day = ms.loadMessagesByDate(dir, '', '2026-07-01');
    assert.ok(day.every(m => typeof m.user === 'string'));
});

test('loadMessagesByDate: 非法 date 不穿越目录', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'load-messages-trav-'));
    const dir = path.join(root, 'group');
    fs.mkdirSync(dir);
    // 放在 dir 之外，穿越成功时会被读到（真实攻击目标是仓库根的 cookies.json）
    fs.writeFileSync(path.join(root, 'weibo_chat_secret.json'), JSON.stringify([
        { id: 9, user: 'leak', timestamp: 1, time: '2026/07/01 10:00:00', content: 'secret' },
    ]));

    for (const bad of ['../secret', '../../secret', 'secret/../../secret', '2026-07-01/../../secret']) {
        assert.deepStrictEqual(ms.loadMessagesByDate(root, 'group', bad), [], `date=${bad} 应被拒绝`);
    }
    assert.strictEqual(ms.isValidDate('2026-07-01'), true);
    assert.strictEqual(ms.isValidDate('../secret'), false);
    assert.strictEqual(ms.isValidDate(''), false);
});
