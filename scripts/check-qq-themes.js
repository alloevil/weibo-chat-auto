'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const puppeteer = require('puppeteer');
const { resolveChromePath } = require('../lib/chrome-path');
const { uniqueGroupKey, writeGroupMetadata } = require('../lib/group-storage');

const artifacts = path.resolve(process.env.WEIBO_UI_ARTIFACTS || 'output/playwright/qq-themes');
const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'weibo-qq-themes-'));
const groupName = '周末造物社 · 产品与技术';
const group = uniqueGroupKey(groupName);
const directory = path.join(dataRoot, 'output', group);
fs.mkdirSync(directory, { recursive: true });
fs.mkdirSync(artifacts, { recursive: true });
fs.writeFileSync(path.join(dataRoot, 'config.json'), JSON.stringify({ groups: [groupName] }));
writeGroupMetadata(directory, { groupName, groupId: '990001', storageKey: group });
const users = ['林青禾', '周予', '陈屿', '半夏'];
const lines = [
    '早上好！把群聊档案整理了一下，之前讨论的内容现在能顺着上下文找回来了。',
    '部署方案已经定了，回滚包单独保留，不覆盖旧版本。',
    '消息从左侧开始，名字、时间和正文分清楚，翻历史就轻松多了。',
    '先完成灰度部署，再观察一小时，有问题及时回滚。',
    '长消息验收：' + '保留原文、核对日期，不要因为皮肤变化丢掉消息内容。'.repeat(16),
    '短消息也要清楚。',
    '多词检索不要求词语相邻，部署验证后再考虑回滚。',
    'https://example.invalid/' + 'long-reference-'.repeat(45),
];
const messages = lines.map((content, index) => ({
    id: `qq-${index}`,
    user: users[index % users.length],
    from_uid: String(index % users.length),
    avatar: `https://example.invalid/avatar-${index % users.length}.svg`,
    content,
    time: `2026/10/12 09:${String(41 + index).padStart(2, '0')}:00`,
    timestamp: Date.parse('2026-10-12T09:41:00+08:00') + index * 60000,
    date: '2026-10-12',
    pics: [],
}));
fs.writeFileSync(path.join(directory, 'weibo_chat_2026-10-12.json'), JSON.stringify(messages));
process.env.WEIBO_DATA_ROOT = dataRoot;
process.env.WEIBO_COOKIE_FILE = path.join(dataRoot, 'cookies.json');
const { createViewerServer } = require('./viewer-server');

async function main() {
    const server = createViewerServer();
    let browser;
    const results = [];
    const errors = [];
    const external = [];
    try {
        await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
        browser = await puppeteer.launch({
            executablePath: resolveChromePath(),
            headless: true,
            args: ['--no-sandbox'],
        });
        for (const width of [1280, 360]) {
            for (const theme of ['qq2012', 'qqmodern']) {
                const context = await browser.createBrowserContext();
                const page = await context.newPage();
                page.on('pageerror', (error) => errors.push(error.message));
                await page.setViewport({ width, height: width === 360 ? 800 : 900 });
                await page.emulateMediaFeatures([
                    { name: 'prefers-reduced-motion', value: 'reduce' },
                ]);
                await page.setRequestInterception(true);
                page.on('request', (request) => {
                    const url = new URL(request.url());
                    if (!['http:', 'https:'].includes(url.protocol)) return request.continue();
                    if (url.hostname === 'example.invalid' && url.pathname.startsWith('/avatar-')) {
                        return request.respond({
                            contentType: 'image/svg+xml',
                            body: '<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64"><rect width="64" height="64" fill="#d2e5f4"/><circle cx="32" cy="25" r="12" fill="#597b96"/><path d="M10 64v-7a22 22 0 0 1 44 0v7" fill="#597b96"/></svg>',
                        });
                    }
                    if (url.hostname !== '127.0.0.1') {
                        external.push(request.url());
                        return request.abort();
                    }
                    if (url.pathname === '/api/version')
                        return request.respond({
                            contentType: 'application/json',
                            body: '{"current":"1.29.0","hasUpdate":false}',
                        });
                    if (url.pathname === '/api/emotions')
                        return request.respond({
                            contentType: 'application/json',
                            body: '{"ok":true,"map":{}}',
                        });
                    return request.continue();
                });
                const base = `http://127.0.0.1:${server.address().port}`;
                await page.goto(base, { waitUntil: 'networkidle0' });
                await page.click('#settingsBtn');
                await page.select('#themeSelect', theme);
                await page.keyboard.press('Escape');
                await page.reload({ waitUntil: 'networkidle0' });
                assert.equal(await page.$eval('html', (element) => element.dataset.theme), theme);
                assert.equal(await page.$eval('#themeSelect', (element) => element.value), theme);
                await page.waitForFunction(() =>
                    [...globalThis.document.querySelectorAll('.msg-avatar img')].every(
                        (image) => image.complete && image.naturalWidth
                    )
                );
                await page.waitForFunction('readingPositionReady === true');
                await page.$eval('#messages', (element) => {
                    element.scrollTop = 0;
                });
                await page.evaluate(
                    () =>
                        new Promise((resolve) =>
                            globalThis.requestAnimationFrame(() =>
                                globalThis.requestAnimationFrame(resolve)
                            )
                        )
                );
                const geometry = await page.evaluate(() => {
                    const rectangle = (selector) => {
                        const bounds = globalThis.document
                            .querySelector(selector)
                            .getBoundingClientRect();
                        return {
                            left: bounds.left,
                            right: bounds.right,
                            width: bounds.width,
                            height: bounds.height,
                        };
                    };
                    return {
                        scope: rectangle('#searchScope'),
                        input: rectangle('#searchInput'),
                        outer: rectangle('#navSearch'),
                        content: rectangle('.content'),
                        navHeight: rectangle('.nav').height,
                        scrollWidth: globalThis.document.documentElement.scrollWidth,
                        border: globalThis.getComputedStyle(
                            globalThis.document.querySelector('#searchInput')
                        ).borderLeftWidth,
                        bubbleBorder: globalThis.getComputedStyle(
                            globalThis.document.querySelector('.msg-content')
                        ).borderLeftWidth,
                        duplicateTitle: globalThis.getComputedStyle(
                            globalThis.document.querySelector('.nav-context')
                        ).display,
                        photos: globalThis.document.querySelectorAll('.msg-avatar img').length,
                    };
                });
                assert.equal(geometry.scrollWidth, width);
                assert.equal(geometry.content.left, 0);
                assert.equal(geometry.content.width, width);
                assert.ok(geometry.input.left >= geometry.scope.right);
                assert.ok(geometry.input.right <= geometry.outer.right);
                assert.equal(geometry.border, '0px');
                assert.equal(geometry.bubbleBorder, '1px');
                assert.equal(geometry.duplicateTitle, 'none');
                assert.equal(geometry.photos, messages.length);
                assert.ok(
                    geometry.navHeight < (width === 360 ? 260 : 200),
                    `Navigation too tall: ${geometry.navHeight}`
                );
                assert.deepEqual(
                    await page.$$eval('.msg-content', (elements) =>
                        elements.map(
                            (element) => element.querySelector('a')?.href || element.textContent
                        )
                    ),
                    lines
                );
                await page.screenshot({
                    path: path.join(artifacts, `${theme}-${width}-reading.png`),
                });
                if (width === 360) {
                    const menu = await page.$eval('.msg-menu > summary', (element) => {
                        const range = globalThis.document.createRange();
                        range.selectNodeContents(element);
                        const text = range.getBoundingClientRect();
                        const button = element.getBoundingClientRect();
                        return {
                            textLeft: text.left,
                            textRight: text.right,
                            left: button.left,
                            right: button.right,
                        };
                    });
                    assert.ok(
                        menu.textLeft >= menu.left && menu.textRight <= menu.right,
                        `消息菜单文字溢出: ${JSON.stringify(menu)}`
                    );
                }
                await page.select('#searchScope', 'combined');
                await page.type('#searchInput', '部署 回滚');
                await page.click('#combinedSearchSubmit');
                await page.waitForFunction(
                    () => globalThis.document.querySelectorAll('.sr-row').length === 3
                );
                await page.screenshot({
                    path: path.join(artifacts, `${theme}-${width}-search.png`),
                });
                assert.equal(
                    await page.evaluate(() => globalThis.document.documentElement.scrollWidth),
                    width
                );
                if (!(await page.$eval('#combinedSearchControls', (element) => element.open))) {
                    await page.locator('#combinedSearchControls > summary').click();
                }
                await page.locator('#combinedSearchForm button[onclick="clearSearch()"]').click();
                await page.waitForFunction(
                    () =>
                        globalThis.document.querySelector('#combinedSearchControls').open &&
                        globalThis.document.querySelector('#searchInput').value === ''
                );
                await page.locator('#researchPanel > .research-header .ctx-close').click();
                await page.waitForFunction(
                    () =>
                        !globalThis.document
                            .querySelector('#researchPanel')
                            .classList.contains('open')
                );
                await page.reload({ waitUntil: 'networkidle0' });
                await page.waitForSelector('#msg-qq-0');
                await page.waitForFunction('readingPositionReady === true');
                await page.$eval('#messages', (element) => {
                    element.scrollTop = 0;
                });
                await page.evaluate(
                    () =>
                        new Promise((resolve) =>
                            globalThis.requestAnimationFrame(() =>
                                globalThis.requestAnimationFrame(resolve)
                            )
                        )
                );
                assert.equal(await page.$eval('html', (element) => element.dataset.theme), theme);
                if (width === 360) {
                    await page.evaluate(() => {
                        globalThis.__menuEvents = [];
                        globalThis.document.addEventListener(
                            'click',
                            (event) =>
                                globalThis.__menuEvents.push({
                                    type: 'click',
                                    target: event.target.outerHTML.slice(0, 200),
                                }),
                            true
                        );
                        globalThis.document
                            .querySelector('#msg-qq-0 .msg-menu')
                            .addEventListener('toggle', (event) =>
                                globalThis.__menuEvents.push({
                                    type: 'toggle',
                                    open: event.target.open,
                                })
                            );
                    });
                    await page.click('#msg-qq-0 .msg-menu > summary');
                    await page.evaluate(
                        () =>
                            new Promise((resolve) =>
                                globalThis.requestAnimationFrame(() =>
                                    globalThis.requestAnimationFrame(resolve)
                                )
                            )
                    );
                    fs.writeFileSync(
                        path.join(artifacts, `${theme}-menu-hit.json`),
                        JSON.stringify(
                            await page.evaluate(() => {
                                const menu =
                                    globalThis.document.querySelector('#msg-qq-0 .msg-menu');
                                const button = menu.querySelector('button');
                                const box = button.getBoundingClientRect();
                                return {
                                    events: globalThis.__menuEvents,
                                    open: menu.open,
                                    menu: menu.outerHTML,
                                    rect: {
                                        x: box.x,
                                        y: box.y,
                                        width: box.width,
                                        height: box.height,
                                    },
                                    hit: globalThis.document
                                        .elementFromPoint(
                                            box.x + box.width / 2,
                                            box.y + box.height / 2
                                        )
                                        ?.outerHTML.slice(0, 500),
                                    panelOpen: globalThis.document
                                        .querySelector('#researchPanel')
                                        .classList.contains('open'),
                                };
                            }),
                            null,
                            2
                        )
                    );
                    await page.screenshot({ path: path.join(artifacts, `${theme}-menu-open.png`) });
                    assert.equal(
                        await page.$eval('#msg-qq-0 .msg-menu-body button', (button) => {
                            const box = button.getBoundingClientRect();
                            return (
                                globalThis.document.elementFromPoint(
                                    box.x + box.width / 2,
                                    box.y + box.height / 2
                                ) === button
                            );
                        }),
                        true,
                        '展开菜单的点击中心必须命中上下文按钮'
                    );
                    await page.locator('#msg-qq-0 .msg-menu-body button').click();
                } else {
                    await page.locator('#msg-qq-0').hover();
                    await page.locator('#msg-qq-0 .msg-ctx-btn').click();
                }
                await page.waitForFunction(
                    () =>
                        globalThis.document.querySelector('#researchPanel').dataset.view ===
                        'context'
                );
                await page.screenshot({
                    path: path.join(artifacts, `${theme}-${width}-context.png`),
                });
                await page.keyboard.press('Escape');
                await page.click('#settingsBtn');
                await page.select('#themeSelect', 'archive');
                await page.keyboard.press('Escape');
                assert.equal(
                    await page.$eval('html', (element) => element.dataset.theme),
                    'archive'
                );
                results.push({ theme, width, status: 'PASS', ...geometry });
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
            `PASS ${results.length} QQ theme/viewport cases; persisted theme, avatars, single search border, no overflow, 3 combined hits, return to archive theme`
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
