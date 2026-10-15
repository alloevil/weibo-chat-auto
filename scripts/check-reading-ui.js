'use strict';

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const assert = require('node:assert/strict');
const {
    launchTestBrowser,
    newTestPage,
    handleNonLocalRequest,
    waitForLayout,
} = require('./browser-test-utils');
const { clickNavAction } = require('./browser-nav-test');
const artifacts = path.resolve(process.env.WEIBO_UI_ARTIFACTS || 'output/playwright/reading-ui');
const baseline = process.env.WEIBO_BEFORE_VIEWER;
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'weibo-reading-ui-'));
const directory = path.join(root, 'output', 'synthetic');
fs.mkdirSync(directory, { recursive: true });
fs.mkdirSync(artifacts, { recursive: true });
process.env.WEIBO_DATA_ROOT = root;
process.env.WEIBO_COOKIE_FILE = path.join(root, 'cookies.json');
const separator = ' - - - - - - - - - - - - - - - ';
const quoted = '明天先发布小范围体验版，观察一天。没有异常再扩大范围，旧版本和回滚说明都保留。';
const longText =
    '我把这次讨论的结论整理一下。阅读页面首先要让大家找到自己想看的记录，而不是让工具按钮占满整个屏幕。搜索可以按发言人和归档日期组合，查到以后回到原文，核对前后的讨论，再返回原来的结果。\n\n引用内容是辅助线索，自己的回复才是当前消息的重点。如果同一句话有多个来源，页面需要保留不确定性，但不用把内部判断逻辑全部写在消息旁边。想确认的人可以主动展开，其他人继续阅读就好。\n\n部署前还要检查手机上的长文、图片和文件，以及切换群聊后的阅读位置。同步失败不能改变上次成功同步的记录，后台更新也不应突然把人带回最新消息。等这些基本行为确认后，再考虑其他功能。';
const definitions = [
    ['hello', '林青禾', '早上好，昨天的记录我已经归档了。'],
    ['source', '周予', quoted],
    ['reply', '半夏', `「${quoted}」${separator}收到。我会先把回滚文档补齐，发布后再一起核对。`],
    ['short', '陈屿', '好的，先保证阅读和查找顺手。'],
    ['long', '林青禾', longText],
    ['file', '周予', '上线核对清单.pdf'],
    ['link', '陈屿', '相关说明：https://example.invalid/notes/archive-reader'],
];
const users = ['林青禾', '周予', '半夏', '陈屿'];
const messages = definitions.map(([id, user, content], index) => ({
    id,
    user,
    from_uid: String(users.indexOf(user)),
    content,
    avatar: `https://example.invalid/avatar-${users.indexOf(user)}.svg`,
    date: '2026-10-15',
    time: `2026/10/15 09:${String(10 + index).padStart(2, '0')}:00`,
    timestamp: Date.parse('2026-10-15T09:10:00+08:00') + index * 60000,
    pics: id === 'file' ? ['https://example.invalid/checklist.pdf'] : [],
}));
fs.writeFileSync(path.join(directory, 'weibo_chat_2026-10-15.json'), JSON.stringify(messages));
const { createViewerServer } = require('./viewer-server');

async function main() {
    const server = createViewerServer();
    let browser;
    const errors = [];
    const external = [];
    const results = [];
    try {
        await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
        browser = await launchTestBrowser();
        for (const theme of ['archive', '', 'qq2000', 'qq2008', 'qq2012', 'qqmodern']) {
            for (const width of [1280, 360]) {
                const context = await browser.createBrowserContext();
                const page = await newTestPage(context, errors);
                await page.setViewport({ width, height: width === 360 ? 800 : 900 });
                await page.emulateMediaFeatures([
                    { name: 'prefers-reduced-motion', value: 'reduce' },
                ]);
                await page.evaluateOnNewDocument(
                    (theme) => globalThis.localStorage.setItem('viewer-theme', theme),
                    theme
                );
                await page.setRequestInterception(true);
                page.on('request', (request) => {
                    const url = new URL(request.url());
                    if (url.hostname === 'example.invalid' && url.pathname.startsWith('/avatar-')) {
                        const color = ['#6589a9', '#78877b', '#a07e8b', '#8c81a0'][
                            Number(url.pathname.match(/\d/)[0])
                        ];
                        return request.respond({
                            contentType: 'image/svg+xml',
                            body: `<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64"><rect width="64" height="64" fill="#edf1f5"/><circle cx="32" cy="23" r="12" fill="${color}"/><path d="M9 64v-7a23 23 0 0 1 46 0v7" fill="${color}"/></svg>`,
                        });
                    }
                    if (handleNonLocalRequest(request, external)) return;
                    if (url.pathname === '/' && baseline)
                        return request.respond({
                            contentType: 'text/html',
                            body: fs.readFileSync(baseline, 'utf8'),
                        });
                    const reply = (body) =>
                        request.respond({
                            contentType: 'application/json',
                            body: JSON.stringify(body),
                        });
                    if (url.pathname === '/api/version') return reply({ current: '1.30.0' });
                    if (url.pathname === '/api/emotions') return reply({ map: {} });
                    return request.continue();
                });
                await page.goto(`http://127.0.0.1:${server.address().port}`, {
                    waitUntil: 'networkidle0',
                });
                await page.waitForFunction('readingPositionReady === true');
                await page.waitForFunction(() =>
                    [...globalThis.document.querySelectorAll('.msg-avatar img')].every(
                        (image) => image.complete && image.naturalWidth > 0
                    )
                );
                await page.$eval('#messages', (element) => {
                    element.scrollTop = 0;
                });
                await waitForLayout(page);
                const measurements = await page.evaluate(() => {
                    const rect = (selector) => {
                        const bounds = globalThis.document
                            .querySelector(selector)
                            .getBoundingClientRect();
                        return {
                            left: bounds.left,
                            top: bounds.top,
                            width: bounds.width,
                            height: bounds.height,
                        };
                    };
                    const style = (selector) => {
                        const computed = globalThis.getComputedStyle(
                            globalThis.document.querySelector(selector)
                        );
                        return {
                            color: computed.color,
                            background: computed.backgroundColor,
                            fontSize: computed.fontSize,
                            border: computed.borderLeftColor,
                        };
                    };
                    return {
                        nav: rect('.compact-nav'),
                        long: rect('#msg-long .msg-content'),
                        short: rect('#msg-short .msg-content'),
                        attachment: rect('#msg-file .msg-file'),
                        sender: style('#msg-reply .msg-user'),
                        quote: style('#msg-reply .forward-quote'),
                        quoteSender: style('#msg-reply .quote-author'),
                        reply: style('#msg-reply .forward-reply'),
                        longText:
                            globalThis.document.querySelector('#msg-long .msg-content').textContent,
                        overflow: globalThis.document.documentElement.scrollWidth,
                        images: globalThis.document.querySelectorAll('.msg-avatar img').length,
                    };
                });
                assert.equal(measurements.longText, longText);
                assert.equal(measurements.images, messages.length);
                assert.equal(measurements.overflow, width);
                assert.ok(measurements.long.left < 100, 'Reading must stay left aligned');
                if (!baseline) {
                    assert.ok(
                        measurements.long.width <= 52 * parseFloat(measurements.reply.fontSize) + 1
                    );
                    assert.equal(
                        await page.$eval(
                            '#msg-reply .quote-jump',
                            (element) => element.textContent
                        ),
                        '核对原文'
                    );
                    if (theme === 'qq2012' || theme === 'qqmodern') {
                        assert.ok(measurements.short.width < measurements.long.width);
                        assert.equal(measurements.quoteSender.color, measurements.sender.color);
                    }
                }
                const shot = (suffix) =>
                    page.screenshot({
                        path: path.join(artifacts, `${theme || 'dark'}-${width}-${suffix}.png`),
                    });
                await shot('reading');
                await page.locator('#msg-file').scroll();
                await shot('attachment');
                await page.locator('#msg-reply .quote-sender-help').click();
                assert.equal(
                    await page.$eval('#msg-reply .quote-sender-note', (element) => element.hidden),
                    false
                );
                await page.locator('#msg-reply .quote-sender-help').click();
                await page.locator('#msg-reply .quote-jump').click();
                await page.waitForSelector('#contextReferences');
                assert.match(
                    await page.$eval('#contextReferences', (element) => element.textContent),
                    /不确认来源/
                );
                await page.keyboard.press('Escape');
                await clickNavAction(page, '#settingsBtn');
                await page.keyboard.press('Escape');
                results.push({ theme, width, ...measurements, status: 'PASS' });
                await context.close();
            }
        }
        assert.deepEqual(errors, []);
        assert.deepEqual(external, []);
        fs.writeFileSync(
            path.join(artifacts, 'report.json'),
            JSON.stringify({ baseline: !!baseline, results, errors, external }, null, 2)
        );
        console.log(
            `PASS ${results.length} theme/viewport reading checks: full text, avatars, links, quote disclosure and original-source navigation; external requests 0`
        );
    } finally {
        if (browser) await browser.close();
        await new Promise((resolve) => server.close(resolve));
        fs.rmSync(root, { recursive: true, force: true });
    }
}
main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
