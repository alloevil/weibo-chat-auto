const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { loadChunkIndex, buildChunksForMessages, indexPathFor, clearIndexCache } = require('../lib/chunk-index.js');

function setupGroupDir() {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'chunk-index-test-'));
    fs.mkdirSync(path.join(dir, 'qa-index'), { recursive: true });
    return dir;
}

function writeDayFile(dir, date, messages) {
    const p = path.join(dir, `weibo_chat_${date}.json`);
    fs.writeFileSync(p, JSON.stringify(messages));
    return fs.statSync(p).mtimeMs;
}

function writeIndex(dir, date, { sourceMtime, sourceCount, chunks = [] }) {
    fs.writeFileSync(indexPathFor(dir, date), JSON.stringify({ version: 1, date, sourceMtime, sourceCount, chunks }));
}

const MSGS = [
    { id: 1, user: 'a', timestamp: 1000, time: '2026/07/01 10:00:00', content: 'x' },
    { id: 2, user: 'b', timestamp: 2000, time: '2026/07/01 10:00:01', content: 'y' },
];

test('loadChunkIndex: 新鲜索引命中', () => {
    clearIndexCache();
    const dir = setupGroupDir();
    const mtime = writeDayFile(dir, '2026-07-01', MSGS);
    writeIndex(dir, '2026-07-01', { sourceMtime: mtime, sourceCount: 2, chunks: [{ seq: 0, key: 'k', msgIds: [1, 2], annotation: '话题:测试' }] });

    const { byDate, staleDates } = loadChunkIndex(dir, ['2026-07-01']);
    assert.deepStrictEqual(staleDates, []);
    assert.strictEqual(byDate.get('2026-07-01').chunks[0].annotation, '话题:测试');
});

test('loadChunkIndex: 源文件变更后判 stale', () => {
    clearIndexCache();
    const dir = setupGroupDir();
    const mtime = writeDayFile(dir, '2026-07-01', MSGS);
    writeIndex(dir, '2026-07-01', { sourceMtime: mtime, sourceCount: 2 });
    // 源文件被增量归档覆盖(mtime 变化)
    fs.utimesSync(path.join(dir, 'weibo_chat_2026-07-01.json'), new Date(), new Date(Date.now() + 5000));

    const { byDate, staleDates } = loadChunkIndex(dir, ['2026-07-01']);
    assert.deepStrictEqual(staleDates, ['2026-07-01']);
    assert.strictEqual(byDate.get('2026-07-01'), null);
});

test('loadChunkIndex: 索引缺失/损坏 → stale 降级,不抛错', () => {
    clearIndexCache();
    const dir = setupGroupDir();
    writeDayFile(dir, '2026-07-01', MSGS);
    // 无索引文件
    let r = loadChunkIndex(dir, ['2026-07-01', '2026-07-02']);
    assert.deepStrictEqual(r.staleDates, ['2026-07-01', '2026-07-02']);
    // 损坏索引
    fs.writeFileSync(indexPathFor(dir, '2026-07-01'), '{broken json');
    r = loadChunkIndex(dir, ['2026-07-01']);
    assert.deepStrictEqual(r.staleDates, ['2026-07-01']);
});

test('buildChunksForMessages: 降级即时切块,annotation 为 null', () => {
    const chunks = buildChunksForMessages(MSGS);
    assert.strictEqual(chunks.length, 1);
    assert.strictEqual(chunks[0].annotation, null);
    assert.deepStrictEqual(chunks[0].msgIds, [1, 2]);
});
