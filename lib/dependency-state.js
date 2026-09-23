'use strict';

function directDependencyNames(lock) {
    const root = lock?.packages?.[''] || {};
    return [
        ...new Set([
            ...Object.keys(root.dependencies || {}),
            ...Object.keys(root.devDependencies || {}),
            ...Object.keys(root.optionalDependencies || {}),
        ]),
    ].sort();
}

function compareInstalledLock(rootLock, installedLock) {
    const problems = [];
    for (const name of directDependencyNames(rootLock)) {
        const path = `node_modules/${name}`;
        const expected = rootLock?.packages?.[path]?.version;
        const actual = installedLock?.packages?.[path]?.version;
        if (!expected) problems.push(`${name}: 根 lockfile 缺少解析版本`);
        else if (!actual) problems.push(`${name}: 未安装`);
        else if (actual !== expected) problems.push(`${name}: 已安装 ${actual}，需要 ${expected}`);
    }
    return problems;
}

module.exports = { directDependencyNames, compareInstalledLock };
