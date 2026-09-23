const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { ensurePrivateFileMode, writePrivateJson } = require('../lib/private-json');

function tempFile() {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'private-json-test-'));
    return path.join(dir, 'secret.json');
}

test('writePrivateJson: 原子写入并将权限收紧为 0600', () => {
    const file = tempFile();
    fs.writeFileSync(file, '{"old":true}', { mode: 0o644 });

    writePrivateJson(file, { apiKey: 'test-secret', enabled: true });

    assert.deepStrictEqual(JSON.parse(fs.readFileSync(file, 'utf-8')), {
        apiKey: 'test-secret',
        enabled: true,
    });
    assert.strictEqual(fs.statSync(file).mode & 0o777, 0o600);
    assert.deepStrictEqual(
        fs.readdirSync(path.dirname(file)).filter((name) => name.includes('.tmp-')),
        []
    );
});

test('ensurePrivateFileMode: 收紧已有文件；缺失文件安全跳过', () => {
    const file = tempFile();
    assert.strictEqual(ensurePrivateFileMode(file), false);
    fs.writeFileSync(file, '{}', { mode: 0o644 });
    assert.strictEqual(ensurePrivateFileMode(file), true);
    assert.strictEqual(fs.statSync(file).mode & 0o777, 0o600);
});
