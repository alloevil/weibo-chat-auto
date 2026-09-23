const { test } = require('node:test');
const assert = require('node:assert');
const {
    SUPPORTED_NODE_RANGE,
    parseNodeVersion,
    isSupportedNodeVersion,
} = require('../lib/node-version');

test('parseNodeVersion: 接受 v 前缀并解析三段版本', () => {
    assert.deepStrictEqual(parseNodeVersion('v22.13.1'), { major: 22, minor: 13, patch: 1 });
    assert.deepStrictEqual(parseNodeVersion('24.0.0'), { major: 24, minor: 0, patch: 0 });
    assert.strictEqual(parseNodeVersion('garbage'), null);
});

test('isSupportedNodeVersion: 真实依赖下限为 22.13 LTS 或 24+', () => {
    assert.strictEqual(SUPPORTED_NODE_RANGE, '^22.13.0 || >=24.0.0');
    assert.strictEqual(require('../package.json').engines.node, SUPPORTED_NODE_RANGE);
    for (const version of ['20.12.2', '20.19.0', '22.12.0', '23.9.0']) {
        assert.strictEqual(isSupportedNodeVersion(version), false, version);
    }
    for (const version of ['22.13.0', '22.22.1', '24.0.0', '25.6.1']) {
        assert.strictEqual(isSupportedNodeVersion(version), true, version);
    }
});

test('Puppeteer 的实际 Node 下限不会高于项目声明', () => {
    const fs = require('fs');
    const path = require('path');
    const puppeteerPackage = JSON.parse(
        fs.readFileSync(path.join(__dirname, '..', 'node_modules', 'puppeteer', 'package.json'))
    );
    assert.strictEqual(puppeteerPackage.engines.node, '>=22.12.0');
    assert.strictEqual(isSupportedNodeVersion('22.12.0'), false, '还需满足 ESLint 22.13 下限');
});
