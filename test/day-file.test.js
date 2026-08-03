const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const df = require('../lib/day-file.js');

function tmpdir() {
    return fs.mkdtempSync(path.join(os.tmpdir(), 'day-file-test-'));
}

const msg = (id, ts) => ({ id, timestamp: ts, time: df.formatLocalTime(ts), date: df.formatLocalDate(ts), content: 'c' + id });

test('formatLocalDate/formatLocalTime 用本地时区且零填充', () => {
    // 选一个 UTC 与本地不同天的时刻（UTC+8 下为次日 01:30）
    const ts = Date.parse('2026-07-03T16:30:05Z');
    const d = new Date(ts);
    const expectDate = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

    assert.strictEqual(df.formatLocalDate(ts), expectDate);
    // 必须是本地日期，不能是 toISOString 的 UTC 切片
    if (d.getDate() !== d.getUTCDate()) {
        assert.notStrictEqual(df.formatLocalDate(ts), new Date(ts).toISOString().slice(0, 10));
    }

    // YYYY/MM/DD HH:mm:ss，月/日/时/分/秒全部两位（viewer 按 split(' ') 解析）
    assert.match(df.formatLocalTime(ts), /^\d{4}\/\d{2}\/\d{2} \d{2}:\d{2}:\d{2}$/);
    assert.strictEqual(df.formatLocalTime(ts).split(' ')[0].replace(/\//g, '-'), expectDate);

    // 单位数月/日也要零填充（旧版 toLocaleString 无 2-digit 会给 2026/7/3）
    const jan = Date.parse('2026-01-05T12:00:00');
    assert.match(df.formatLocalTime(jan), /^2026\/01\/05 /);
});

test('writeJsonAtomic 不留临时文件', () => {
    const dir = tmpdir();
    const f = path.join(dir, 'a.json');
    df.writeJsonAtomic(f, { x: 1 });
    assert.deepStrictEqual(JSON.parse(fs.readFileSync(f, 'utf-8')), { x: 1 });
    assert.deepStrictEqual(fs.readdirSync(dir), ['a.json']);
});

test('mergeIntoDayFile: 文件不存在时新建', () => {
    const dir = tmpdir();
    const f = path.join(dir, 'weibo_chat_2026-07-03.json');
    const r = df.mergeIntoDayFile(f, [msg(2, 2000), msg(1, 1000)]);

    assert.deepStrictEqual({ existing: r.existing, total: r.total, corruptBackup: r.corruptBackup },
        { existing: 0, total: 2, corruptBackup: null });
    // 按 timestamp 升序落盘
    assert.deepStrictEqual(JSON.parse(fs.readFileSync(f, 'utf-8')).map(m => m.id), [1, 2]);
});

test('mergeIntoDayFile: 与既有消息按 id 去重合并', () => {
    const dir = tmpdir();
    const f = path.join(dir, 'weibo_chat_2026-07-03.json');
    df.writeJsonAtomic(f, [msg(1, 1000), msg(2, 2000)]);

    const r = df.mergeIntoDayFile(f, [msg(2, 2000), msg(3, 3000)]);
    assert.strictEqual(r.existing, 2);
    assert.strictEqual(r.total, 3);
    assert.deepStrictEqual(JSON.parse(fs.readFileSync(f, 'utf-8')).map(m => m.id), [1, 2, 3]);
});

test('mergeIntoDayFile: 兼容 {messages:[...]} 包装格式', () => {
    const dir = tmpdir();
    const f = path.join(dir, 'weibo_chat_2026-07-03.json');
    df.writeJsonAtomic(f, { messages: [msg(1, 1000)] });

    const r = df.mergeIntoDayFile(f, [msg(2, 2000)]);
    assert.strictEqual(r.existing, 1);
    assert.deepStrictEqual(JSON.parse(fs.readFileSync(f, 'utf-8')).map(m => m.id), [1, 2]);
});

test('mergeIntoDayFile: 半截 JSON 备份后重建，历史不被静默丢弃', () => {
    const dir = tmpdir();
    const f = path.join(dir, 'weibo_chat_2026-07-03.json');
    const halfWritten = '[{"id":1,"timestamp":1000,"content":"c1"},{"id":2,"timesta';
    fs.writeFileSync(f, halfWritten);

    const r = df.mergeIntoDayFile(f, [msg(9, 9000)]);

    assert.strictEqual(r.existing, 0, '解析失败视为无既有消息');
    assert.ok(r.corruptBackup, '必须报告备份路径');
    // 原始字节完整保留在备份里 —— 旧版直接覆盖，整天历史无声消失
    assert.strictEqual(fs.readFileSync(r.corruptBackup, 'utf-8'), halfWritten);
    assert.deepStrictEqual(JSON.parse(fs.readFileSync(f, 'utf-8')).map(m => m.id), [9]);
});

test('mergeIntoDayFile: 合法 JSON 但不是消息数组也走备份', () => {
    const dir = tmpdir();
    const f = path.join(dir, 'weibo_chat_2026-07-03.json');
    fs.writeFileSync(f, JSON.stringify({ error: 'not messages' }));

    const r = df.mergeIntoDayFile(f, [msg(9, 9000)]);
    assert.ok(r.corruptBackup);
    assert.deepStrictEqual(JSON.parse(fs.readFileSync(f, 'utf-8')).map(m => m.id), [9]);
});
