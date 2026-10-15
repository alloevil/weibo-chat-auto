'use strict';

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const assert = require('node:assert/strict');
const { launchTestBrowser, newTestPage, handleNonLocalRequest } = require('./browser-test-utils');
const artifacts = path.resolve(process.env.WEIBO_UI_ARTIFACTS || 'output/playwright/quote-sender');
const before = process.argv.includes('--before');
const data = fs.mkdtempSync(path.join(os.tmpdir(), 'quote-sender-ui-'));
const directory = path.join(data, 'output', 'synthetic');
fs.mkdirSync(directory, { recursive: true });
fs.mkdirSync(artifacts, { recursive: true });
const separator = ' - - - - - - - - - - - - - - - ';
const quote = '先核对部署进度。团队之前讨论过下周的计划，新增任务如何安排？';
const longQuote = '这是一条用于验证引用折叠与发送人显示的合成原文。'.repeat(14);
const rows = [
    ['original', '合成原发送人', quote],
    ['reply', '合成回复人', `「${quote}」${separator}@合成成员 收到，明天再核对一次。`],
    ['long-source', '长文原发送人', longQuote],
    ['long-reply', '合成回复人', `「${longQuote}」${separator}已记录。`],
    ['same-one', '同文发送人甲', '同文来源内容'],
    ['same-two', '同文发送人乙', '同文来源内容'],
    ['ambiguous', '合成回复人', `「同文来源内容」${separator}需要核对原文。`],
    ['missing', '合成回复人', `「本日不存在的原文」${separator}仅保留引用内容。`],
    ['repeated-original', '合成原发送人', quote],
];
const messages = rows.map(([id, user, content], index) => ({
    id,
    user,
    content,
    from_uid: user,
    date: '2026-10-14',
    time: `2026/10/14 17:${String(index).padStart(2, '0')}:00`,
    timestamp: Date.parse('2026-10-14T17:00:00+08:00') + index * 60000,
}));
fs.writeFileSync(path.join(directory, 'weibo_chat_2026-10-14.json'), JSON.stringify(messages));
process.env.WEIBO_DATA_ROOT = data;
process.env.WEIBO_COOKIE_FILE = path.join(data, 'cookies.json');
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
        for (const width of [1280, 360]) {
            const context = await browser.createBrowserContext();
            const page = await newTestPage(context, errors);
            await page.setViewport({ width, height: width === 360 ? 800 : 900 });
            await page.evaluateOnNewDocument(() =>
                globalThis.localStorage.setItem('viewer-theme', 'qqmodern')
            );
            await page.emulateMediaFeatures([{ name: 'prefers-reduced-motion', value: 'reduce' }]);
            await page.setRequestInterception(true);
            let archiveRequests = 0;
            page.on('request', (request) => {
                if (handleNonLocalRequest(request, external)) return;
                const url = new URL(request.url());
                if (before && url.pathname === '/')
                    return request.respond({
                        contentType: 'text/html',
                        body: fs.readFileSync(process.env.WEIBO_BEFORE_VIEWER, 'utf8'),
                    });
                if (url.pathname === '/api/messages') archiveRequests++;
                if (url.pathname === '/api/version')
                    return request.respond({
                        contentType: 'application/json',
                        body: '{"current":"1.30.0"}',
                    });
                if (url.pathname === '/api/emotions')
                    return request.respond({ contentType: 'application/json', body: '{"map":{}}' });
                return request.continue();
            });
            await page.goto(`http://127.0.0.1:${server.address().port}`, {
                waitUntil: 'networkidle0',
            });
            await page.waitForFunction('readingPositionReady === true');
            await page.$eval('#messages', (element) => {
                element.scrollTop = 0;
            });
            const label = await page.$eval(
                '#msg-reply .forward-quote',
                (element) => element.querySelector('.quote-author')?.textContent || ''
            );
            if (before) assert.equal(label, '');
            else {
                assert.match(label, /合成原发送人/);
                assert.equal(
                    await page.$eval('#msg-reply .quote-jump', (element) => element.textContent),
                    '核对原文'
                );
                assert.equal(
                    await page.$eval(
                        '#msg-reply .quote-sender-name',
                        (element) => element.textContent
                    ),
                    '合成原发送人：'
                );
                assert.equal(
                    await page.$eval('#msg-reply .quote-sender-note', (element) => element.hidden),
                    true
                );
                assert.match(
                    await page.$eval('#msg-reply .quote-sender-help', (element) => element.title),
                    /尚未确认/
                );
                assert.match(
                    await page.$eval('#msg-reply .quote-sender-help', (element) => element.title),
                    /2 条同文候选.*发送人ID一致.*具体原文尚未确认/
                );
                const missing = await page.$eval(
                    '#msg-missing .quote-author',
                    (element) => element.textContent
                );
                assert.match(missing, /本日归档未定位/);
                const ambiguous = await page.$eval(
                    '#msg-ambiguous .quote-author',
                    (element) => element.textContent
                );
                assert.match(ambiguous, /同文发送人甲/);
                assert.match(ambiguous, /同文发送人乙/);
                assert.match(ambiguous, /2 条同文候选/);
                assert.equal(
                    await page.$eval(
                        '#msg-ambiguous .quote-sender-name',
                        (element) => element.textContent
                    ),
                    '发送人待确认'
                );
                assert.equal(
                    await page.$eval('#msg-long-reply details', (element) => element.open),
                    true
                );
                assert.match(
                    await page.$eval('#msg-long-reply summary', (element) => element.textContent),
                    /长文原发送人/
                );
                assert.equal(
                    await page.$eval(
                        '#msg-long-reply .quote-full',
                        (element) => element.textContent
                    ),
                    longQuote
                );
                await page.locator('#msg-long-reply').scroll();
                await page.screenshot({
                    path: path.join(artifacts, `${width}-long-default-open.png`),
                });
                await page.$eval('#messages', (element) => {
                    element.scrollTop = 0;
                });
            }
            await page.screenshot({ path: path.join(artifacts, `${width}-reading.png`) });
            if (!before) {
                await page.locator('#msg-reply .quote-sender-help').click();
                assert.equal(
                    await page.$eval('#msg-reply .quote-sender-note', (element) => element.hidden),
                    false
                );
                await page.screenshot({ path: path.join(artifacts, `${width}-sender-help.png`) });
                await page.locator('#msg-reply .quote-sender-help').click();
                await page.locator('#msg-long-reply .quote-sender-help').click();
                assert.equal(
                    await page.$eval('#msg-long-reply details', (element) => element.open),
                    true
                );
                assert.equal(
                    await page.$eval('#msg-long-reply .quote-sender-help', (element) =>
                        element.getAttribute('aria-expanded')
                    ),
                    'true'
                );
                await page.keyboard.press('Enter');
                assert.equal(
                    await page.$eval('#msg-long-reply .quote-sender-help', (element) =>
                        element.getAttribute('aria-expanded')
                    ),
                    'false'
                );
                assert.equal(
                    await page.$eval('#msg-long-reply details', (element) => element.open),
                    true
                );
                await page.locator('#msg-long-reply summary').click();
                assert.equal(
                    await page.$eval('#msg-long-reply details', (element) => element.open),
                    false
                );
                await page.locator('#msg-long-reply summary').click();
                assert.equal(
                    await page.$eval('#msg-long-reply details', (element) => element.open),
                    true
                );
                assert.equal(
                    await page.$eval(
                        '#msg-long-reply .quote-full',
                        (element) => element.textContent
                    ),
                    longQuote
                );
                await page.locator('#msg-long-reply summary').click();
                const requestsBefore = archiveRequests;
                await page.locator('#msg-reply .quote-jump').click();
                await page.waitForSelector('#contextReferences');
                assert.match(
                    await page.$eval('#contextReferences', (element) => element.textContent),
                    /合成原发送人/
                );
                assert.match(
                    await page.$eval('#contextReferences', (element) => element.textContent),
                    /不确认来源/
                );
                assert.equal(
                    await page.$$eval(
                        '#contextReferences .ctx-reference-candidate',
                        (elements) => elements.length
                    ),
                    2
                );
                assert.equal(archiveRequests, requestsBefore);
                await page.screenshot({ path: path.join(artifacts, `${width}-candidates.png`) });
                await page.click('#researchPanel > .research-header .ctx-close');
                await page.locator('#msg-long-reply summary').click();
                await page.locator('#msg-long-reply .quote-jump').click();
                await page.waitForSelector('#contextReferences details[open]');
                assert.equal(
                    await page.$eval(
                        '#contextReferences blockquote',
                        (element) => element.textContent
                    ),
                    longQuote
                );
                await page.screenshot({
                    path: path.join(artifacts, `${width}-context-default-open.png`),
                });
                await page.locator('#contextReferences details > summary').click();
                assert.equal(
                    await page.$eval('#contextReferences details', (element) => element.open),
                    false
                );
                await page.locator('.ctx-reference-candidate[data-id="long-source"]').click();
                await page.locator('#contextReturnButton').click();
                await page.waitForSelector('#contextReferences');
                assert.equal(
                    await page.$eval('#contextReferences details', (element) => element.open),
                    false,
                    '主动收起状态在原文往返后保持'
                );
                await page.locator('#contextReferences details > summary').click();
                assert.equal(
                    await page.$eval('#contextReferences details', (element) => element.open),
                    true
                );
                await page.click('#researchPanel > .research-header .ctx-close');
                await page.$eval('#msg-long-source', (element) =>
                    element.scrollIntoView({ block: 'center' })
                );
                if (width === 360) {
                    await page.locator('#msg-long-source .msg-menu > summary').click();
                    await page.locator('#msg-long-source .msg-menu-body button').click();
                } else {
                    await page.locator('#msg-long-source').hover();
                    await page.locator('#msg-long-source .msg-ctx-btn').click();
                }
                await page.waitForSelector('#contextReverseReferences details[open]');
                assert.equal(
                    await page.$eval(
                        '#contextReverseReferences .ctx-reverse-quote',
                        (element) => element.textContent
                    ),
                    longQuote
                );
                await page.locator('#contextReverseReferences details').scroll();
                await page.screenshot({
                    path: path.join(artifacts, `${width}-reverse-default-open.png`),
                });
                await page.locator('#contextReverseReferences details > summary').click();
                assert.equal(
                    await page.$eval(
                        '#contextReverseReferences details',
                        (element) => element.open
                    ),
                    false
                );
                await page.locator('#contextReverseReferences details > summary').click();
                assert.equal(
                    await page.$eval(
                        '#contextReverseReferences details',
                        (element) => element.open
                    ),
                    true
                );
                assert.equal(
                    archiveRequests,
                    requestsBefore,
                    '同日全文展示与来源往返不增加归档请求'
                );
            }
            assert.equal(
                await page.evaluate(() => globalThis.document.documentElement.scrollWidth),
                width
            );
            results.push({ width, label, archiveRequests, status: 'PASS' });
            await context.close();
        }
        assert.deepEqual(errors, []);
        assert.deepEqual(external, []);
        fs.writeFileSync(
            path.join(artifacts, 'report.json'),
            JSON.stringify({ before, results, errors, external }, null, 2)
        );
        console.log(
            `PASS ${before ? 'missing sender reproduced' : 'sender labels and candidate checks'}: desktop/mobile; 0 external requests`
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
