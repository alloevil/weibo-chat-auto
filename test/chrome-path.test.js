const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { resolveChromePath } = require('../lib/chrome-path.js');

test('resolveChromePath: config.json 指定且文件存在时优先于平台探测', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'chrome-path-'));
    const fake = path.join(tmp, 'my-chrome');
    fs.writeFileSync(fake, '');
    try {
        assert.strictEqual(resolveChromePath(fake), fake);
    } finally {
        fs.rmSync(tmp, { recursive: true, force: true });
    }
});

test('resolveChromePath: 平台探测优先于不存在的 config 路径,全落空才回退它', () => {
    // 顺序是 config(存在) → 平台探测 → config(不存在时兜底) → 抛错。
    // 兜底分支只在平台探测无结果时才走到,所以这里把 platform 顶成没有候选的值,
    // 否则装了 Chrome 的机器上会命中 /usr/bin/google-chrome 而测不到这条。
    const missing = path.join(os.tmpdir(), 'definitely-not-a-real-chrome-binary');
    const origPlatform = process.platform;
    Object.defineProperty(process, 'platform', { value: 'aix', configurable: true });
    try {
        assert.strictEqual(resolveChromePath(missing), missing);
    } finally {
        Object.defineProperty(process, 'platform', {
            value: origPlatform,
            configurable: true,
        });
    }
});

test('resolveChromePath: 落空时抛错,而不是退回 puppeteer 自带 Chromium', () => {
    // 这条是 package.json 里 puppeteer.skipDownload 成立的前提:
    // 本项目从不依赖自带 Chromium,所以找不到系统 Chrome 必须显式报错,
    // 让用户去装 Chrome 或填 chromePath——静默退回会让人以为在用自己的 Chrome。
    const origPlatform = process.platform;
    Object.defineProperty(process, 'platform', { value: 'aix', configurable: true });
    try {
        assert.throws(() => resolveChromePath(''), /未找到 Chrome 可执行文件/);
    } finally {
        Object.defineProperty(process, 'platform', {
            value: origPlatform,
            configurable: true,
        });
    }
});

test('每个 puppeteer.launch 都自带 executablePath——这是 skipDownload 可以为 true 的前提', () => {
    // 跳过 Chromium 下载(~650 MB)只在「所有 launch 都指定系统 Chrome」时安全。
    // 若将来有人加了一处不传 executablePath 的 launch,它会去找不存在的自带
    // Chromium,而且只在用户机器上炸——所以在这里挡住。
    const pkg = require('../package.json');
    assert.strictEqual(
        pkg.puppeteer && pkg.puppeteer.skipDownload,
        true,
        'package.json 应保留 puppeteer.skipDownload'
    );

    const roots = ['lib', 'scripts'];
    const files = [];
    for (const root of roots) {
        const dir = path.join(__dirname, '..', root);
        for (const name of fs.readdirSync(dir)) {
            if (/\.(js|mjs)$/.test(name)) files.push(path.join(dir, name));
        }
    }

    const offenders = [];
    for (const file of files) {
        const src = fs.readFileSync(file, 'utf8');
        let idx = src.indexOf('puppeteer.launch(');
        while (idx !== -1) {
            // 取 launch( 之后一段,检查参数对象里是否有 executablePath
            const window = src.slice(idx, idx + 600);
            if (!window.includes('executablePath')) {
                offenders.push(path.basename(file));
            }
            idx = src.indexOf('puppeteer.launch(', idx + 1);
        }
    }

    assert.deepStrictEqual(
        offenders,
        [],
        `这些文件里的 puppeteer.launch 未指定 executablePath: ${offenders.join(', ')}`
    );
});
