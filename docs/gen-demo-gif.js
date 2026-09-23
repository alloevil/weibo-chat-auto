// 录制脱敏演示 GIF（QQ 2012 轻白主题）。所有数据、配置与状态都在临时目录。
// 用法：node docs/gen-demo-gif.js            录制 docs/demo.gif（依赖 Chrome + gifski）
//       node docs/gen-demo-gif.js --preview  只启动隔离演示站，Ctrl+C 清理
'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFileSync } = require('child_process');
const { resolveChromePath } = require('../lib/chrome-path');
const { uniqueGroupKey, writeGroupMetadata } = require('../lib/group-storage');
const { writeRegistry } = require('../lib/group-registry');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'weibo-gif-'));
const FRAMES = path.join(TMP, 'frames');
const OUTPUT_DIR = path.join(TMP, 'output');
const STATE_DIR = path.join(TMP, 'state');
const PREVIEW = process.argv.includes('--preview');
const users = ['林青禾', 'Kev_码农', '阿渡', '半夏', 'tomo', '老白'];
const groups = [
    {
        name: '开源茶馆演示群',
        id: '999991',
        date: '2026-09-22',
        lines: [
            '今天试了下新出的本地模型，推理速度比上周快不少',
            '有人用过 Tauri 打包桌面应用吗？体积比 Electron 小好多',
            'Rust 的所有权刚开始劝退，习惯了真香',
            '周末整理了一下 dotfiles，终于把终端配置统一了',
            '@Kev_码农 那个 CI 的缓存问题解决了吗',
            '解决了，是 lockfile 没提交导致每次重装依赖 😂',
            '深色主题看久了眼睛确实舒服',
            '分享个排版小技巧：负字距用在大标题上很提质感',
            '这个热力图做得不错，一眼看出大家几点最活跃',
            '增量归档这个思路好，断点续传不怕中断',
            '图片防盗链可以本地代理绕过，加个 referrer 处理就行',
            '晚上一起 review 下那个 PR？',
            '好啊，我把改动拆成几个小 commit 方便看',
            '收到，辛苦啦 🙏',
        ],
    },
    {
        name: '产品体验讨论组',
        id: '999992',
        date: '2026-09-23',
        lines: [
            '新版安装器在 Windows Git Bash 也能跑通了',
            '现在选完群就可以直接发消息，不用先归档一次',
            '搜索十几万条记录时快了不少',
            '群名带 emoji 也不会再撞到同一个目录 🎉',
            '设置页的状态提示比之前清楚',
            '这个版本可以准备发布啦',
        ],
    },
];

function messagesFor(group, groupIndex) {
    const base = new Date(`${group.date}T09:00:00+09:00`).getTime();
    const weights = [12, 9, 7, 5, 3, 2];
    const pool = [];
    users.forEach((user, index) => {
        for (let count = 0; count < weights[index]; count++) pool.push(user);
    });
    return Array.from({ length: groupIndex === 0 ? 60 : 36 }, (_, index) => {
        const timestamp = base + index * (1000 * 60 * (8 + (index % 5) * 6));
        const time = new Date(timestamp);
        return {
            id: Number(`${group.id}${String(index).padStart(3, '0')}`),
            from_uid: 1000 + (index % users.length),
            user: pool[(index * 13 + 5) % pool.length],
            avatar: '',
            timestamp,
            time: `${group.date.replace(/-/g, '/')} ${String(time.getHours()).padStart(2, '0')}:${String(time.getMinutes()).padStart(2, '0')}:00`,
            date: group.date,
            content: group.lines[index % group.lines.length],
            type: 321,
            pics: [],
        };
    });
}

function writeFixture() {
    fs.mkdirSync(FRAMES, { recursive: true });
    fs.mkdirSync(OUTPUT_DIR, { recursive: true });
    fs.mkdirSync(path.join(TMP, 'cache'), { recursive: true });
    fs.writeFileSync(
        path.join(TMP, 'config.json'),
        JSON.stringify({ chromePath: '', groups: groups.map((group) => group.name) })
    );
    fs.writeFileSync(
        path.join(TMP, 'cache', 'emotions.json'),
        JSON.stringify({
            fetchedAt: Date.now(),
            map: { '[合成表情]': 'https://example.invalid/emotion.png' },
        })
    );
    const registry = { schemaVersion: 1, groups: [] };
    groups.forEach((group, index) => {
        const storageKey = uniqueGroupKey(group.name);
        const groupDir = path.join(OUTPUT_DIR, storageKey);
        const date = group.date;
        fs.mkdirSync(groupDir, { recursive: true });
        fs.writeFileSync(
            path.join(groupDir, `weibo_chat_${date}.json`),
            JSON.stringify(messagesFor(group, index))
        );
        writeGroupMetadata(groupDir, {
            groupName: group.name,
            groupId: group.id,
            storageKey,
        });
        registry.groups.push({
            groupName: group.name,
            groupId: group.id,
            storageKey,
            updatedAt: '2026-09-23T00:00:00.000Z',
        });
    });
    writeRegistry(path.join(STATE_DIR, 'group-registry.json'), registry);
}

function listen(server) {
    return new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(0, '127.0.0.1', () => resolve(server.address().port));
    });
}

function close(server) {
    return new Promise((resolve) => server.close(resolve));
}

function cleanup() {
    fs.rmSync(TMP, { recursive: true, force: true });
}

async function main() {
    writeFixture();
    process.env.WEIBO_DATA_ROOT = TMP;
    process.env.WEIBO_COOKIE_FILE = path.join(TMP, 'cookies.json');
    process.env.NO_OPEN = '1';
    const { createViewerServer } = require('../scripts/viewer-server');
    const server = createViewerServer();
    const port = await listen(server);
    const url = `http://127.0.0.1:${port}`;

    if (PREVIEW) {
        console.log(`[preview] ${url}`);
        const shutdown = async () => {
            await close(server);
            cleanup();
            process.exit(0);
        };
        process.once('SIGINT', shutdown);
        process.once('SIGTERM', shutdown);
        return;
    }

    let browser;
    try {
        const puppeteer = require('puppeteer');
        browser = await puppeteer.launch({
            headless: 'new',
            executablePath: resolveChromePath(process.env.CHROME_PATH || ''),
            args: ['--no-sandbox', '--disable-setuid-sandbox', '--force-color-profile=srgb'],
            defaultViewport: { width: 1280, height: 800, deviceScaleFactor: 1 },
        });
        const page = await browser.newPage();
        // 皮肤预加载脚本会在首帧读取 localStorage；必须在导航前写入，避免先闪过默认深色。
        await page.evaluateOnNewDocument(() => {
            localStorage.setItem('viewer-theme', 'qq2012');
        });
        await page.setRequestInterception(true);
        page.on('request', (request) => {
            const requestUrl = request.url();
            const pathname = new URL(requestUrl).pathname;
            if (pathname === '/api/auth-status') {
                request.respond({
                    contentType: 'application/json',
                    body: JSON.stringify({ ok: true, code: 0, checkedAt: Date.now() }),
                });
            } else if (pathname === '/api/me') {
                request.respond({
                    contentType: 'application/json',
                    body: JSON.stringify({ ok: true, screenName: '林青禾', uid: '1001' }),
                });
            } else if (pathname === '/api/version') {
                request.respond({
                    contentType: 'application/json',
                    body: JSON.stringify({ ok: true, updateAvailable: false }),
                });
            } else {
                request.continue();
            }
        });
        await page.goto(url, { waitUntil: 'networkidle2', timeout: 30000 });
        await page.waitForSelector('.msg-item', { timeout: 15000 });

        let frame = 0;
        const shot = async () => {
            await page.screenshot({
                path: path.join(FRAMES, `f${String(frame++).padStart(3, '0')}.png`),
            });
        };
        const hold = async (count) => {
            for (let index = 0; index < count; index++) await shot();
        };

        // 场景 1：最新消息视图与工具栏。
        await hold(6);
        for (let index = 0; index < 8; index++) {
            await page.evaluate(() => {
                document.querySelector('.messages').scrollTop += 120;
            });
            await new Promise((resolve) => setTimeout(resolve, 100));
            await shot();
        }

        // 场景 2：切换到另一个群，展示新版稳定 storage key 背后的原始群名。
        await page.select('#groupSelect', uniqueGroupKey(groups[1].name));
        await page.waitForFunction(
            (expected) => document.querySelector('#groupSelect')?.value === expected,
            {},
            uniqueGroupKey(groups[1].name)
        );
        await page.waitForSelector('.msg-item');
        await hold(7);

        // 场景 3：上下文聚焦面板。
        await page.evaluate(() => document.querySelector('.msg-ctx-btn')?.click());
        await page.waitForSelector('.context-panel.open');
        await hold(8);
        await page.evaluate(() => document.querySelector('.ctx-close')?.click());

        // 场景 4：统计面板。
        await page.evaluate(() => document.getElementById('statsToggle')?.click());
        await page.waitForSelector('.stats-panel.show');
        await hold(10);
        for (let index = 0; index < 5; index++) {
            await page.evaluate(() => {
                document.querySelector('.stats-panel').scrollTop += 120;
            });
            await new Promise((resolve) => setTimeout(resolve, 100));
            await shot();
        }
        await hold(5);

        const out = path.join(__dirname, 'demo.gif');
        const frames = fs
            .readdirSync(FRAMES)
            .filter((name) => name.endsWith('.png'))
            .sort()
            .map((name) => path.join(FRAMES, name));
        console.log(`[gif] ${frame} frames captured, encoding...`);
        execFileSync(
            'gifski',
            ['--fps', '10', '--width', '800', '--quality', '75', '-o', out, ...frames],
            { stdio: 'inherit' }
        );
        console.log(`[gif] done: ${out} (${(fs.statSync(out).size / 1024).toFixed(0)} KB)`);
    } finally {
        if (browser) await browser.close();
        await close(server);
        cleanup();
    }
}

main().catch((error) => {
    console.error(error);
    cleanup();
    process.exit(1);
});
