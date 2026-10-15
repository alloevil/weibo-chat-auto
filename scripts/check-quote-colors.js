'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const {
    launchTestBrowser,
    newTestPage,
    handleNonLocalRequest,
    waitForLayout,
} = require('./browser-test-utils');

const artifacts = path.resolve(process.env.WEIBO_UI_ARTIFACTS || 'output/playwright/quote-colors');
const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'quote-colors-'));
const directory = path.join(dataRoot, 'output', 'synthetic');
fs.mkdirSync(directory, { recursive: true });
fs.mkdirSync(artifacts, { recursive: true });
const separator = ' - - - - - - - - - - - - - - - ';
const names = ['林青禾', '周予', '半夏', '陈屿', '苏白', '小满', '季川', '知夏'];
const rows = names.flatMap((name, index) => [
    {
        id: `source-${index}`,
        user: name,
        from_uid: String(index),
        content: `第${index + 1}项安排：先核对原文，再讨论具体实施步骤。`,
    },
    {
        id: `reply-${index}`,
        user: '合成回复人',
        from_uid: 'reply',
        content: `「第${index + 1}项安排：先核对原文，再讨论具体实施步骤。」${separator}收到，按这个计划继续。`,
    },
]);
rows.push({ ...rows[1], id: 'repeat' });
rows.push({
    id: 'missing',
    user: '合成回复人',
    from_uid: 'reply',
    content: `「没有匹配原文」${separator}待核对。`,
});
const messages = rows.map((message, index) => ({
    ...message,
    date: '2026-10-15',
    time: `2026/10/15 09:${String(index).padStart(2, '0')}:00`,
    timestamp: Date.parse('2026-10-15T09:00:00+08:00') + index * 60000,
}));
fs.writeFileSync(path.join(directory, 'weibo_chat_2026-10-15.json'), JSON.stringify(messages));
process.env.WEIBO_DATA_ROOT = dataRoot;
process.env.WEIBO_COOKIE_FILE = path.join(dataRoot, 'cookies.json');
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
                    if (handleNonLocalRequest(request, external)) return;
                    const url = new URL(request.url());
                    if (url.pathname === '/api/version' || url.pathname === '/api/emotions')
                        return request.respond({ contentType: 'application/json', body: '{}' });
                    return request.continue();
                });
                const base = `http://127.0.0.1:${server.address().port}`;
                await page.goto(base, { waitUntil: 'networkidle0' });
                await page.waitForFunction('readingPositionReady === true');
                await page.$eval('#messages', (element) => {
                    element.scrollTop = 0;
                });
                await waitForLayout(page);
                const measure = () =>
                    page.evaluate(() => {
                        const canvas = globalThis.document.createElement('canvas');
                        canvas.width = canvas.height = 1;
                        const context = canvas.getContext('2d');
                        const rgb = (color) => {
                            context.clearRect(0, 0, 1, 1);
                            context.fillStyle = color;
                            context.fillRect(0, 0, 1, 1);
                            return Array.from(context.getImageData(0, 0, 1, 1).data).slice(0, 3);
                        };
                        const luminance = (values) =>
                            values
                                .map((value) => value / 255)
                                .map((value) =>
                                    value <= 0.04045
                                        ? value / 12.92
                                        : ((value + 0.055) / 1.055) ** 2.4
                                )
                                .reduce(
                                    (sum, value, index) =>
                                        sum + value * [0.2126, 0.7152, 0.0722][index],
                                    0
                                );
                        return Array.from({ length: 8 }, (_, index) => {
                            const name = globalThis.document.querySelector(
                                `#msg-reply-${index} .quote-sender-name`
                            );
                            const quote = name.closest('.forward-quote');
                            const color = globalThis.getComputedStyle(name).color;
                            const background = globalThis.getComputedStyle(quote).backgroundColor;
                            const foregroundLuminance = luminance(rgb(color));
                            const backgroundLuminance = luminance(rgb(background));
                            return {
                                id: name.closest('.msg-item').id,
                                color,
                                background,
                                contrast:
                                    (Math.max(foregroundLuminance, backgroundLuminance) + 0.05) /
                                    (Math.min(foregroundLuminance, backgroundLuminance) + 0.05),
                                style: name.getAttribute('style'),
                            };
                        });
                    });
                const colors = await measure();
                assert.equal(new Set(colors.map((entry) => entry.color)).size, 8);
                for (const entry of colors)
                    assert.ok(
                        entry.contrast >= 4.5,
                        `${theme || 'dark'} ${entry.color}: ${entry.contrast}`
                    );
                assert.equal(
                    await page.$eval(
                        '#msg-repeat .quote-sender-name',
                        (element) => globalThis.getComputedStyle(element).color
                    ),
                    colors[0].color
                );
                assert.equal(
                    await page.$eval(
                        '#msg-missing .quote-sender-name',
                        (element) =>
                            globalThis.getComputedStyle(element).color ===
                            globalThis.getComputedStyle(element.parentElement).color
                    ),
                    true
                );
                assert.equal(
                    await page.evaluate(() => globalThis.document.documentElement.scrollWidth),
                    width
                );
                await page.screenshot({
                    path: path.join(artifacts, `${theme || 'dark'}-${width}.png`),
                });
                await page.reload({ waitUntil: 'networkidle0' });
                await page.waitForSelector('#msg-reply-0 .quote-sender-name');
                assert.deepEqual(await measure(), colors);
                results.push({ theme: theme || 'dark', width, colors, status: 'PASS' });
                await context.close();
            }
        }
        assert.deepEqual(errors, []);
        assert.deepEqual(external, []);
        fs.writeFileSync(
            path.join(artifacts, 'report.json'),
            JSON.stringify({ results, errors, external }, null, 2)
        );
        console.log(
            `PASS 12 theme/viewport cases; 8 palette colors contrast >=4.5, repeat and reload stable, unresolved neutral; minimum contrast ${Math.min(...results.flatMap((row) => row.colors.map((color) => color.contrast))).toFixed(2)}:1`
        );
    } finally {
        if (browser) await browser.close();
        await new Promise((resolve) => server.close(resolve));
        fs.rmSync(dataRoot, { recursive: true, force: true });
    }
}
main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
