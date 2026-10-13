'use strict';

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const assert = require('node:assert/strict');
const puppeteer = require('puppeteer');
const { resolveChromePath } = require('../lib/chrome-path');
const { clickNavAction } = require('./browser-nav-test');

const artifacts = path.resolve(process.env.WEIBO_UI_ARTIFACTS || 'output/playwright/compact-nav');
const data = fs.mkdtempSync(path.join(os.tmpdir(), 'weibo-compact-nav-'));
process.env.WEIBO_DATA_ROOT = data;
process.env.WEIBO_COOKIE_FILE = path.join(data, 'cookies.json');
const directory = path.join(data, 'output', 'synthetic');
fs.mkdirSync(directory, { recursive: true });
fs.mkdirSync(artifacts, { recursive: true });
const messages = Array.from({ length: 12 }, (_, index) => ({
    id: `nav-${index}`,
    user: ['林青禾', '周予'][index % 2],
    from_uid: String(index % 2),
    content: '先部署验证，再核对回滚步骤。这是导航验收使用的合成记录。',
    date: '2026-10-13',
    time: `2026/10/13 09:${String(index).padStart(2, '0')}:00`,
    timestamp: Date.parse('2026-10-13T09:00:00+08:00') + index * 60000,
}));
fs.writeFileSync(path.join(directory, 'weibo_chat_2026-10-13.json'), JSON.stringify(messages));
const { createViewerServer } = require('./viewer-server');

async function main() {
    const server = createViewerServer();
    let browser;
    const results = [];
    const errors = [];
    let syncCalls = 0;
    let completeSync;
    const external = [];
    try {
        await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
        browser = await puppeteer.launch({
            executablePath: resolveChromePath(),
            headless: true,
            args: ['--no-sandbox'],
        });
        const page = await browser.newPage();
        page.on('pageerror', (error) => errors.push(error.message));
        await page.emulateMediaFeatures([{ name: 'prefers-reduced-motion', value: 'reduce' }]);
        await page.setRequestInterception(true);
        page.on('request', (request) => {
            const url = new URL(request.url());
            if (!['http:', 'https:'].includes(url.protocol)) return request.continue();
            if (url.hostname !== '127.0.0.1') {
                external.push(request.url());
                return request.abort();
            }
            const reply = (body) =>
                request.respond({ contentType: 'application/json', body: JSON.stringify(body) });
            if (url.pathname === '/api/version') return reply({ current: '1.30.0' });
            if (url.pathname === '/api/emotions') return reply({ map: {} });
            if (url.pathname === '/api/ai-config')
                return reply({
                    ok: true,
                    configured: true,
                    missingFields: [],
                    config: {
                        baseUrl: 'http://127.0.0.1:1/v1',
                        apiKey: 'synthetic-placeholder',
                        model: 'offline-test',
                    },
                });
            if (url.pathname === '/api/sync') {
                syncCalls++;
                completeSync = () => reply({ ok: false, error: '合成错误：未实际同步' });
                return;
            }
            return request.continue();
        });
        const base = `http://127.0.0.1:${server.address().port}`;
        for (const width of [2048, 1280, 900, 360]) {
            await page.setViewport({ width, height: width === 360 ? 800 : 900 });
            await page.goto(base, { waitUntil: 'networkidle0' });
            await page.waitForSelector('.msg-item');
            for (const theme of ['archive', '', 'qq2000', 'qq2008', 'qq2012', 'qqmodern']) {
                await clickNavAction(page, '#settingsBtn');
                await page.select('#themeSelect', theme);
                await page.keyboard.press('Escape');
                assert.equal(
                    await page.evaluate(() => globalThis.document.activeElement.id),
                    'archiveMoreToggle'
                );
                const geometry = await page.evaluate(() => {
                    const box = (selector) => {
                        const rect = globalThis.document
                            .querySelector(selector)
                            .getBoundingClientRect();
                        return {
                            left: rect.left,
                            right: rect.right,
                            top: rect.top,
                            height: rect.height,
                            width: rect.width,
                        };
                    };
                    return {
                        nav: box('.compact-nav'),
                        search: box('#navSearch'),
                        scope: box('#searchScope'),
                        input: box('#searchInput'),
                        date: box('#archiveNavToggle'),
                        group: box('#groupPickerToggle'),
                        more: box('#archiveMoreToggle'),
                        content: box('.content'),
                        overflow: globalThis.document.documentElement.scrollWidth,
                        hiddenActions: ['settingsBtn', 'codeModeToggle'].every(
                            (id) =>
                                globalThis.document.getElementById(id).getBoundingClientRect()
                                    .height === 0
                        ),
                        shortcuts: ['syncBtn', 'toolsToggle', 'qaToggle'].map((id) => {
                            const button = globalThis.document.getElementById(id);
                            return {
                                id,
                                parent: button.parentElement.id,
                                width: button.getBoundingClientRect().width,
                                label: button.getAttribute('aria-label'),
                                description: button.getAttribute('aria-describedby'),
                            };
                        }),
                    };
                });
                assert.equal(geometry.overflow, width);
                assert.ok(
                    geometry.nav.height <= (width > 900 ? 70 : 110),
                    JSON.stringify({ theme, width, geometry })
                );
                assert.equal(geometry.hiddenActions, true);
                for (const shortcut of geometry.shortcuts) {
                    assert.equal(
                        shortcut.parent,
                        width > 900 ? 'navQuickActions' : 'navMobileActions'
                    );
                    assert.ok(shortcut.label && shortcut.description);
                    if (width > 900) assert.equal(shortcut.width, 34);
                }
                assert.equal(geometry.content.left, 0);
                assert.equal(geometry.content.width, width);
                assert.ok(geometry.search.width <= (width > 900 ? 462 : width));
                assert.ok(geometry.input.left >= geometry.scope.right);
                assert.ok(geometry.input.right <= geometry.search.right);
                if (width > 900) assert.ok(Math.abs(geometry.search.top - geometry.date.top) < 10);
                const shot = (name) =>
                    page.screenshot({
                        path: path.join(artifacts, `${theme || 'dark'}-${width}-${name}.png`),
                    });
                if (width > 900) {
                    for (const id of ['syncBtn', 'toolsToggle', 'qaToggle']) {
                        await page.hover(`#${id}`);
                        assert.equal(
                            await page.$eval(
                                `#${id}Tip`,
                                (element) => globalThis.getComputedStyle(element).display !== 'none'
                            ),
                            true
                        );
                        await page.mouse.move(0, 0);
                        await page.focus(`#${id}`);
                        assert.equal(
                            await page.$eval(
                                `#${id}Tip`,
                                (element) => globalThis.getComputedStyle(element).display !== 'none'
                            ),
                            true
                        );
                        const tip = await page.$eval(`#${id}Tip`, (element) => {
                            const box = element.getBoundingClientRect();
                            return { left: box.left, right: box.right, text: element.textContent };
                        });
                        assert.ok(tip.left >= 0 && tip.right <= width);
                        assert.ok(tip.text.length > 4);
                        if (theme === 'qqmodern' && id === 'toolsToggle') await shot('tooltip');
                        await page.keyboard.press('Escape');
                        assert.equal(
                            await page.$eval(
                                `#${id}Tip`,
                                (element) => globalThis.getComputedStyle(element).display
                            ),
                            'none'
                        );
                    }
                }
                if (['archive', 'qqmodern', 'qq2012'].includes(theme)) await shot('reading');
                await page.focus('#archiveMoreToggle');
                await page.keyboard.press('Enter');
                await page.keyboard.press('Tab');
                assert.equal(
                    await page.evaluate(() => globalThis.document.activeElement.id),
                    width > 900 ? 'latestArchiveBtn' : 'syncBtn'
                );
                assert.match(
                    await page.$eval('#codeModeToggle', (element) => element.textContent),
                    /代码日志外观.*不会脱敏/s
                );
                const menu = await page.$eval('.archive-more-menu', (element) => {
                    const box = element.getBoundingClientRect();
                    return { left: box.left, right: box.right, bottom: box.bottom };
                });
                assert.ok(
                    menu.left >= 0 &&
                        menu.right <= width &&
                        menu.bottom <= (width === 360 ? 800 : 900)
                );
                if (['archive', 'qqmodern', 'qq2012'].includes(theme)) await shot('more');
                await page.keyboard.press('Escape');
                assert.equal(await page.$eval('#archiveMore', (element) => element.open), false);
                assert.equal(
                    await page.evaluate(() => globalThis.document.activeElement.id),
                    'archiveMoreToggle'
                );
                await page.click('#archiveMoreToggle');
                await page.click('#messages', { offset: { x: 2, y: 2 } });
                assert.equal(await page.$eval('#archiveMore', (element) => element.open), false);
                await clickNavAction(page, '#codeModeToggle');
                assert.equal(
                    await page.$eval('body', (element) => element.classList.contains('code-mode')),
                    true
                );
                await page.click('#codeModeExit');
                assert.equal(
                    await page.evaluate(() => globalThis.document.activeElement.id),
                    'archiveMoreToggle'
                );
                await page.click('#archiveNavToggle');
                assert.equal(
                    await page.$eval('#archiveNav', (element) =>
                        element.classList.contains('open')
                    ),
                    true
                );
                await page.keyboard.press('Escape');
                assert.equal(
                    await page.evaluate(() => globalThis.document.activeElement.id),
                    'archiveNavToggle'
                );
                const filterBefore = await page.$eval('#toolsPanel', (element) =>
                    element.classList.contains('show')
                );
                await clickNavAction(page, '#toolsToggle');
                assert.equal(
                    await page.$eval('#toolsPanel', (element) =>
                        element.classList.contains('show')
                    ),
                    !filterBefore
                );
                assert.equal(
                    await page.$eval('#toolsToggle', (element) =>
                        element.getAttribute('aria-expanded')
                    ),
                    String(!filterBefore)
                );
                await clickNavAction(page, '#toolsToggle');
                await clickNavAction(page, '#qaToggle');
                await page.waitForFunction(
                    () =>
                        globalThis.document
                            .querySelector('#researchPanel')
                            .classList.contains('open') &&
                        globalThis.document.querySelector('#researchPanel').dataset.view === 'ai'
                );
                assert.equal(
                    await page.$eval(
                        '#qaInput',
                        (element) => element.getBoundingClientRect().height > 0
                    ),
                    true
                );
                assert.equal(
                    await page.$eval('#qaToggle', (element) =>
                        element.getAttribute('aria-expanded')
                    ),
                    'true'
                );
                assert.equal(
                    await page.$eval('#qaToggle', (element) => element.classList.contains('open')),
                    true
                );
                await page.click('#researchPanel > .research-header .ctx-close');
                assert.equal(
                    await page.evaluate(() => globalThis.document.activeElement.id),
                    width > 900 ? 'qaToggle' : 'archiveMoreToggle'
                );
                results.push({ theme, width, ...geometry, status: 'PASS' });
            }
            await page.$eval('#groupPickerLabel', (element) => {
                element.textContent = '一个很长的合成群名用于检验省略和箭头不会被推到远处'.repeat(
                    3
                );
            });
            assert.equal(
                await page.evaluate(() => globalThis.document.documentElement.scrollWidth),
                width
            );
            assert.equal(
                await page.$eval(
                    '#groupPickerToggle',
                    (element) => element.getBoundingClientRect().width <= 320
                ),
                true
            );
        }
        assert.equal(syncCalls, 0, '默认导航操作不能触发同步');
        await page.evaluate(() => {
            globalThis.__shortcutNodes = ['syncBtn', 'toolsToggle', 'qaToggle'].map((id) =>
                globalThis.document.getElementById(id)
            );
        });
        await page.setViewport({ width: 1280, height: 900 });
        await page.focus('#toolsToggle');
        await page.setViewport({ width: 360, height: 800 });
        await page.waitForFunction(
            () => globalThis.document.activeElement.id === 'archiveMoreToggle'
        );
        await clickNavAction(page, '#toolsToggle');
        await page.setViewport({ width: 1280, height: 900 });
        await page.waitForFunction(
            () =>
                globalThis.document.querySelector('#toolsToggle').parentElement.id ===
                'navQuickActions'
        );
        assert.equal(
            await page.$eval('#toolsToggle', (element) => element.getAttribute('aria-expanded')),
            'true'
        );
        assert.equal(
            await page.evaluate(() =>
                globalThis.__shortcutNodes.every(
                    (button) =>
                        button === globalThis.document.getElementById(button.id) &&
                        globalThis.document.querySelectorAll(`#${button.id}`).length === 1
                )
            ),
            true
        );
        await clickNavAction(page, '#toolsToggle');
        await page.emulateMediaFeatures([
            { name: 'prefers-reduced-motion', value: 'no-preference' },
        ]);
        await Promise.all([
            page.waitForRequest((request) => new URL(request.url()).pathname === '/api/sync'),
            clickNavAction(page, '#syncBtn'),
        ]);
        await page.waitForFunction(() => globalThis.document.querySelector('#syncBtn').disabled);
        assert.equal(
            await page.$eval('#syncBtn', (element) => element.getAttribute('aria-label')),
            '同步中…'
        );
        assert.equal(await page.$eval('#syncBtnTip', (element) => element.textContent), '同步中…');
        assert.equal(
            await page.$eval(
                '#syncBtn .ui-icon',
                (element) => globalThis.getComputedStyle(element).animationName
            ),
            'iconSpin'
        );
        await page.click('#syncBtn');
        assert.equal(syncCalls, 1);
        await page.setViewport({ width: 360, height: 800 });
        await page.click('#archiveMoreToggle');
        assert.equal(
            await page.$eval(
                '#syncBtn',
                (element) => element.disabled && element.parentElement.id === 'navMobileActions'
            ),
            true
        );
        await page.screenshot({ path: path.join(artifacts, 'mobile-sync-pending.png') });
        await completeSync();
        await page.waitForFunction(() => !globalThis.document.querySelector('#syncBtn').disabled);
        assert.equal(syncCalls, 1, '仅明确点击发送一次模拟同步请求');
        assert.equal(
            await page.$eval('#syncBtn', (element) => element.getAttribute('aria-label')),
            '同步归档'
        );
        assert.equal(
            await page.$eval('#syncBtn', (element) => element.classList.contains('syncing')),
            false
        );
        assert.deepEqual(errors, []);
        assert.deepEqual(external, []);
        fs.writeFileSync(
            path.join(artifacts, 'report.json'),
            JSON.stringify({ results, errors, external, syncCalls }, null, 2)
        );
        console.log(
            `PASS ${results.length} theme/viewport cases; hover/focus tooltips, responsive same-node shortcuts, active states and disabled syncing; sync ${syncCalls} explicit / 0 automatic`
        );
    } finally {
        if (browser) await browser.close();
        await new Promise((resolve) => server.close(resolve));
        fs.rmSync(data, { recursive: true, force: true });
    }
}
main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
