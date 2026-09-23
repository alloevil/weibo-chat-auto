const { test } = require('node:test');
const assert = require('node:assert');
const { directDependencyNames, compareInstalledLock } = require('../lib/dependency-state');

const rootLock = {
    packages: {
        '': {
            dependencies: { alpha: '^1.0.0' },
            devDependencies: { beta: '^2.0.0' },
            optionalDependencies: { gamma: '^3.0.0' },
        },
        'node_modules/alpha': { version: '1.2.0' },
        'node_modules/beta': { version: '2.1.0' },
        'node_modules/gamma': { version: '3.0.0' },
    },
};

test('directDependencyNames: 汇总生产、开发与可选直接依赖并排序', () => {
    assert.deepStrictEqual(directDependencyNames(rootLock), ['alpha', 'beta', 'gamma']);
});

test('compareInstalledLock: 同步时无问题', () => {
    assert.deepStrictEqual(compareInstalledLock(rootLock, rootLock), []);
});

test('compareInstalledLock: 报告缺失、版本过期与根 lock 异常', () => {
    const installed = {
        packages: {
            'node_modules/alpha': { version: '1.1.0' },
            'node_modules/beta': { version: '2.1.0' },
        },
    };
    const brokenRoot = JSON.parse(JSON.stringify(rootLock));
    delete brokenRoot.packages['node_modules/gamma'];
    const problems = compareInstalledLock(brokenRoot, installed);
    assert.deepStrictEqual(problems, [
        'alpha: 已安装 1.1.0，需要 1.2.0',
        'gamma: 根 lockfile 缺少解析版本',
    ]);
});
