const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { readLastSuccessfulSync, recordSuccessfulSync } = require('../lib/sync-state');

function directory(context) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sync-state-test-'));
    context.after(() => fs.rmSync(root, { recursive: true, force: true }));
    return path.join(root, 'state');
}

test('sync time: missing record is unknown history, not archive modification time', (context) => {
    const state = directory(context);
    assert.equal(readLastSuccessfulSync(state), null);
    assert.equal(fs.existsSync(state), false);
});

test('sync time: successful completion stores only the timestamp and survives another process', (context) => {
    const state = directory(context);
    const timestamp = '2026-10-13T08:40:12.000Z';
    assert.equal(recordSuccessfulSync(state, new Date(timestamp)), timestamp);
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(state, 'sync-status.json'), 'utf8')), {
        lastSuccessfulSyncAt: timestamp,
    });
    const child = spawnSync(
        process.execPath,
        [
            '-e',
            `console.log(require(${JSON.stringify(require.resolve('../lib/sync-state'))}).readLastSuccessfulSync(process.argv[1]))`,
            state,
        ],
        { encoding: 'utf8' }
    );
    assert.equal(child.status, 0, child.stderr);
    assert.equal(child.stdout.trim(), timestamp);
});

test('sync time: newer successful completion replaces the record atomically', (context) => {
    const state = directory(context);
    recordSuccessfulSync(state, new Date('2026-10-12T08:00:00Z'));
    recordSuccessfulSync(state, new Date('2026-10-13T08:00:00Z'));
    assert.equal(readLastSuccessfulSync(state), '2026-10-13T08:00:00.000Z');
    assert.deepEqual(fs.readdirSync(state), ['sync-status.json']);
});

test('sync time: corrupt or invalid records surface errors rather than never synced', (context) => {
    const state = directory(context);
    fs.mkdirSync(state);
    for (const value of [
        '{',
        '{}',
        '{"lastSuccessfulSyncAt":null}',
        '{"lastSuccessfulSyncAt":"invalid"}',
    ]) {
        fs.writeFileSync(path.join(state, 'sync-status.json'), value);
        assert.throws(() => readLastSuccessfulSync(state));
    }
});

test('sync time: invalid time or unwritable target does not claim success', (context) => {
    const state = directory(context);
    recordSuccessfulSync(state, new Date('2026-10-12T08:00:00Z'));
    assert.throws(() => recordSuccessfulSync(state, new Date('invalid')));
    assert.equal(readLastSuccessfulSync(state), '2026-10-12T08:00:00.000Z');
    fs.unlinkSync(path.join(state, 'sync-status.json'));
    fs.mkdirSync(path.join(state, 'sync-status.json'));
    assert.throws(() => recordSuccessfulSync(state));
    assert.deepEqual(fs.readdirSync(state), ['sync-status.json']);
});
