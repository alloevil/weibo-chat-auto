'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const assert = require('node:assert/strict');
const {
    launchTestBrowser,
    newTestPage,
    handleNonLocalRequest,
    waitForLayout,
} = require('./browser-test-utils');
const { clickNavAction } = require('./browser-nav-test');

const artifacts = path.resolve(process.env.WEIBO_UI_ARTIFACTS || 'output/playwright/last-sync');
const data = fs.mkdtempSync(path.join(os.tmpdir(), 'last-sync-ui-'));
fs.mkdirSync(artifacts, { recursive: true });
const archiveDirectory = path.join(data, 'output', 'synthetic');
fs.mkdirSync(archiveDirectory, { recursive: true });
fs.writeFileSync(
    path.join(archiveDirectory, 'weibo_chat_2026-10-13.json'),
    JSON.stringify([
        {
            id: 'one',
            user: '合成用户',
            from_uid: 'one',
            date: '2026-10-13',
            time: '2026/10/13 09:00:00',
            timestamp: Date.parse('2026-10-13T09:00:00Z'),
            content: '上次成功同步时间验收，只使用本地合成数据。',
        },
    ])
);
const worker = path.join(data, 'synthetic-archive');
fs.writeFileSync(
    worker,
    `#!${process.execPath}\nconst fs=require('node:fs');const path=require('node:path');const mode=JSON.parse(fs.readFileSync(path.join(process.env.WEIBO_DATA_ROOT,'test-mode.json'),'utf8'));console.log(mode.code===0?'完成！':'错误: Error: synthetic failure');process.exitCode=mode.code;\n`,
    { mode: 0o755 }
);
const setMode = (code) =>
    fs.writeFileSync(path.join(data, 'test-mode.json'), JSON.stringify({ code }));
setMode(0);
process.env.WEIBO_DATA_ROOT = data;
process.env.WEIBO_COOKIE_FILE = path.join(data, 'absent-cookies.json');
process.env.WEIBO_TASK_EXECUTABLE = worker;
const auth = require('../lib/weibo-auth');
const originalProbe = auth.probeAuthCodeHttp;
auth.probeAuthCodeHttp = async () => 0;
const { createViewerServer } = require('./viewer-server');

async function main() {
    const server = createViewerServer();
    let browser;
    const errors = [];
    const external = [];
    const results = [];
    const stateFile = path.join(data, 'state', 'sync-status.json');
    let heldStatus;
    let holdStatus = false;
    try {
        await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
        const base = `http://127.0.0.1:${server.address().port}`;
        browser = await launchTestBrowser();
        const page = await newTestPage(browser, errors);
        await page.emulateTimezone('Asia/Shanghai');
        await page.emulateMediaFeatures([{ name: 'prefers-reduced-motion', value: 'reduce' }]);
        await page.evaluateOnNewDocument(() =>
            globalThis.localStorage.setItem('viewer-theme', 'qqmodern')
        );
        await page.setRequestInterception(true);
        page.on('request', (request) => {
            const url = new URL(request.url());
            if (handleNonLocalRequest(request, external)) return;
            const reply = (body) =>
                request.respond({ contentType: 'application/json', body: JSON.stringify(body) });
            if (url.pathname === '/api/version') return reply({ current: '1.30.0' });
            if (url.pathname === '/api/emotions') return reply({ map: {} });
            if (url.pathname === '/api/sync-status' && holdStatus) {
                heldStatus = request;
                return;
            }
            return request.continue();
        });
        const statusText = () => page.$eval('#lastSyncMobile', (element) => element.textContent);
        const waitText = (text) =>
            page.waitForFunction(
                (value) =>
                    globalThis.document.querySelector('#lastSyncMobile').textContent === value,
                {},
                text
            );
        const shot = (name) => page.screenshot({ path: path.join(artifacts, name + '.png') });
        const dismissToast = async () => {
            if (await page.$eval('#toast', (element) => element.classList.contains('show'))) {
                await page.locator('#toast').click();
            }
        };
        const sync = async (code) => {
            setMode(code);
            const responsePromise = page.waitForResponse(
                (response) => new URL(response.url()).pathname === '/api/sync'
            );
            await clickNavAction(page, '#syncBtn');
            const body = await (await responsePromise).json();
            await page.waitForFunction(
                () => !globalThis.document.querySelector('#syncBtn').disabled
            );
            await dismissToast();
            return body;
        };
        await page.setViewport({ width: 1280, height: 900 });
        await page.goto(base, { waitUntil: 'networkidle0' });
        await waitText('尚未成功同步');
        await page.focus('#syncBtn');
        await shot('desktop-never');
        const start = Date.now();
        const success = await sync(0);
        assert.equal(success.ok, true);
        assert.equal(success.syncTimeSaved, true);
        assert.ok(Date.parse(success.lastSuccessfulSyncAt) >= start);
        const savedText = await statusText();
        assert.match(savedText, /^上次同步成功：\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
        await page.mouse.move(0, 0);
        await page.focus('#searchInput');
        await page.focus('#syncBtn');
        await shot('desktop-success');
        await page.reload({ waitUntil: 'networkidle0' });
        await waitText(savedText);
        const failed = await sync(1);
        assert.equal(failed.ok, false);
        assert.equal(await statusText(), savedText);
        await page.reload({ waitUntil: 'networkidle0' });
        await waitText(savedText);
        results.push({
            scenario: 'real-http-success-failure-refresh',
            success,
            failed,
            text: savedText,
        });
        await page.setViewport({ width: 360, height: 800 });
        await page.click('#archiveMoreToggle');
        assert.equal(
            await page.$eval(
                '#lastSyncMobile',
                (element) => element.getBoundingClientRect().height > 0
            ),
            true
        );
        await shot('mobile-success-after-failure');
        await page.keyboard.press('Escape');
        const mobileSuccess = await sync(0);
        assert.equal(mobileSuccess.ok, true);
        await page.reload({ waitUntil: 'networkidle0' });
        await page.waitForFunction(() =>
            globalThis.document
                .querySelector('#lastSyncMobile')
                .textContent.startsWith('上次同步成功：')
        );
        results.push({
            scenario: 'mobile-success-refresh',
            response: mobileSuccess,
            text: await statusText(),
        });
        holdStatus = true;
        await page.goto(base, { waitUntil: 'domcontentloaded' });
        await page.waitForSelector('.msg-item');
        await waitText('正在读取上次同步时间…');
        assert.ok(heldStatus);
        const raceSuccess = await sync(0);
        const latestText = await statusText();
        assert.match(latestText, /^上次同步成功：/);
        holdStatus = false;
        const staleResponse = page.waitForResponse(
            (response) => new URL(response.url()).pathname === '/api/sync-status'
        );
        await heldStatus.respond({
            contentType: 'application/json',
            body: JSON.stringify({ ok: true, lastSuccessfulSyncAt: null }),
        });
        await staleResponse;
        await waitForLayout(page);
        assert.equal(await statusText(), latestText);
        results.push({
            scenario: 'stale-status-does-not-overwrite-success',
            response: raceSuccess,
            text: latestText,
        });
        fs.writeFileSync(stateFile, '{bad-json');
        await page.reload({ waitUntil: 'networkidle0' });
        await waitText('上次同步时间读取失败');
        fs.unlinkSync(stateFile);
        fs.mkdirSync(stateFile);
        const unsaved = await sync(0);
        assert.equal(unsaved.syncTimeSaved, false);
        assert.match(await statusText(), /时间未保存/);
        await page.click('#archiveMoreToggle');
        await shot('mobile-time-save-failed');
        results.push({
            scenario: 'failed-persistence-not-hidden',
            response: unsaved,
            text: await statusText(),
        });
        fs.rmdirSync(stateFile);
        const finalSuccess = await sync(0);
        assert.equal(finalSuccess.syncTimeSaved, true);
        await page.setViewport({ width: 1280, height: 900 });
        await page.waitForFunction(
            () =>
                globalThis.document.querySelector('#syncBtn').parentElement.id === 'navQuickActions'
        );
        const nav = await page.$eval(
            '.compact-nav',
            (element) => element.getBoundingClientRect().height
        );
        assert.equal(nav, 64);
        assert.equal(
            await page.$eval(
                '.sync-action-copy',
                (element) => element.getBoundingClientRect().width
            ),
            1
        );
        assert.equal(
            await page.evaluate(() => globalThis.document.documentElement.scrollWidth),
            1280
        );
        assert.deepEqual(errors, []);
        assert.deepEqual(external, []);
        fs.writeFileSync(
            path.join(artifacts, 'report.json'),
            JSON.stringify({ status: 'PASS', results, errors, external }, null, 2)
        );
        console.log(
            'PASS real HTTP sync status: never/success/failure/refresh/mobile/stale response/read error/save error; 0 external requests'
        );
    } finally {
        if (browser) await browser.close();
        await new Promise((resolve) => server.close(resolve));
        auth.probeAuthCodeHttp = originalProbe;
        fs.rmSync(data, { recursive: true, force: true });
    }
}
main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
