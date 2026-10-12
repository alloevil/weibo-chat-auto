'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const puppeteer = require('puppeteer');
const { resolveChromePath } = require('../lib/chrome-path');
const { searchMessages } = require('../lib/search-messages');

const root = path.resolve(__dirname, '..');
const artifacts = process.env.WEIBO_UI_ARTIFACTS
    ? path.resolve(process.env.WEIBO_UI_ARTIFACTS)
    : path.join(root, 'output/playwright/w2-task-return');
const reproduce = process.argv.includes('--repro');
const normalMotion = process.argv.includes('--normal-motion');
const groups = [
    { id: 'synthetic-alpha', name: '合成技术讨论群' },
    { id: 'synthetic-beta', name: '合成阅读讨论群' },
];
const dates = ['2026-09-20', '2026-09-21', '2026-09-22'];
const messages = groups.flatMap((group) =>
    dates.flatMap((date) =>
        Array.from({ length: 45 }, (_, index) => ({
            id: `${group.id}-${date}-${index}`,
            group: group.id,
            date,
            user: index % 2 ? '测试乙' : '测试甲',
            from_uid: String(index % 2),
            content: `部署方案第 ${index} 条：先核对回滚步骤，再决定是否发布。这是合成消息。`,
            timestamp: Date.parse(`${date}T09:00:00+08:00`) + index * 60000,
            time: `${date.replaceAll('-', '/')} 09:${String(index).padStart(2, '0')}:00`,
            pics: [],
        }))
    )
);

async function main() {
    fs.mkdirSync(artifacts, { recursive: true });
    const server = http.createServer((request, response) => {
        const pathname = new URL(request.url, 'http://localhost').pathname;
        const file = pathname === '/' ? 'viewer.html' : pathname.slice(1);
        if (!['viewer.html', 'lib/text-utils.js', 'lib/viewer-filters.js'].includes(file)) {
            response.writeHead(404);
            response.end();
            return;
        }
        response.setHeader(
            'Content-Type',
            file.endsWith('.html') ? 'text/html; charset=utf-8' : 'text/javascript; charset=utf-8'
        );
        response.end(fs.readFileSync(path.join(root, file)));
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const base = `http://127.0.0.1:${server.address().port}`;
    let browser;
    const results = [];
    try {
        browser = await puppeteer.launch({
            headless: true,
            executablePath: resolveChromePath(process.env.CHROME_PATH || ''),
            args: ['--no-sandbox'],
        });
        for (const width of [1440, 360]) {
            const context = await browser.createBrowserContext();
            const page = await context.newPage();
            await page.setViewport({ width, height: width === 360 ? 800 : 960 });
            await page.emulateMediaFeatures([
                {
                    name: 'prefers-reduced-motion',
                    value: normalMotion ? 'no-preference' : 'reduce',
                },
            ]);
            const calls = { qa: 0, search: 0, external: 0 };
            let failReturn = false;
            let holdSource = false;
            let releaseSource;
            const errors = [];
            page.on('pageerror', (error) => errors.push(error.message));
            await page.setRequestInterception(true);
            page.on('request', (request) => {
                const url = new URL(request.url());
                const reply = (data) =>
                    request.respond({
                        contentType: 'application/json',
                        body: JSON.stringify(data),
                    });
                if (url.origin !== base) {
                    calls.external++;
                    return request.abort();
                }
                if (!url.pathname.startsWith('/api/')) return request.continue();
                const group = url.searchParams.get('group') || groups[0].id;
                if (url.pathname === '/api/groups') return reply({ groups });
                if (url.pathname === '/api/dates')
                    return reply({ dates: Object.fromEntries(dates.map((date) => [date, 45])) });
                if (url.pathname === '/api/messages') {
                    if (failReturn && url.searchParams.get('date') === dates[2])
                        return request.abort();
                    const payload = {
                        messages: messages.filter(
                            (message) =>
                                message.group === group &&
                                message.date === url.searchParams.get('date')
                        ),
                    };
                    if (holdSource && url.searchParams.get('date') === dates[1]) {
                        releaseSource = () => reply(payload);
                        return;
                    }
                    return reply(payload);
                }
                if (url.pathname === '/api/search') {
                    calls.search++;
                    return reply({
                        ok: true,
                        ...searchMessages(
                            messages.filter((message) => message.group === group),
                            url.searchParams.get('q'),
                            { limit: 60, offset: Number(url.searchParams.get('offset') || 0) }
                        ),
                    });
                }
                if (url.pathname === '/api/ai-config')
                    return reply({
                        ok: true,
                        configured: true,
                        missingFields: [],
                        config: {
                            baseUrl: 'https://example.invalid',
                            model: 'synthetic',
                            apiKey: 'synthetic-not-a-key',
                        },
                    });
                if (url.pathname === '/api/qa') {
                    calls.qa++;
                    return reply({
                        ok: true,
                        answer: '合成回答：部署方案先核对回滚步骤，再决定发布。\n\n请逐条核对来源。',
                        sources: [
                            {
                                date: dates[0],
                                id: `${groups[0].id}-${dates[0]}-12`,
                                user: '测试甲',
                                preview: '部署方案第 12 条',
                            },
                        ],
                        keywords: ['部署'],
                        dateRange: { from: dates[0], to: dates[2] },
                    });
                }
                if (url.pathname === '/api/live-config')
                    return reply({ enabled: false, groups: [] });
                if (url.pathname === '/api/schedule') return reply({ supported: false });
                if (url.pathname === '/api/emotions') return reply({});
                if (url.pathname === '/api/auth-status') return reply({ ok: true });
                if (url.pathname === '/api/version')
                    return reply({ ok: true, updateAvailable: false });
                return reply({ ok: true, enabled: false });
            });
            const visible = (selector) =>
                page.$eval(selector, (element) => !!element.getBoundingClientRect().height);
            const savedPosition = () =>
                page.evaluate(() =>
                    globalThis.localStorage.getItem('viewer-reading-v1:synthetic-alpha')
                );
            const shot = (suffix) =>
                page.screenshot({
                    path: path.join(
                        artifacts,
                        `${reproduce ? 'before' : 'after'}-${width}-${suffix}.png`
                    ),
                });
            await page.goto(base, { waitUntil: 'networkidle0' });
            await page.waitForSelector('.msg-item');
            if (!reproduce) {
                await page.evaluate(() => {
                    globalThis.toggleUser('测试甲');
                    globalThis.toggleNoise();
                    globalThis.toggleHour(
                        Number(globalThis.document.querySelector('.msg-item').dataset.hour)
                    );
                });
            }
            await page.$eval('#messages', (element) => {
                element.scrollTop = 160;
            });
            await page.evaluate(() => globalThis.saveReadingPosition());
            await page.type('#searchInput', '部署');
            await page.waitForSelector('#searchMoreBtn');
            await page.click('#searchMoreBtn');
            await page.waitForFunction(
                () => globalThis.document.querySelectorAll('.sr-row').length === 120
            );
            await page.$eval('.sr-list', (element) => {
                element.children[70].scrollIntoView({ block: 'center' });
            });
            const before = await page.$eval('#searchResults', (element) => ({
                html: element.innerHTML,
                top: element.querySelector('.sr-list').scrollTop,
            }));
            if (!reproduce) {
                await page.$eval('#messages', (element) => {
                    element.scrollTop = 160;
                });
                await page.evaluate(() => globalThis.saveReadingPosition());
            }
            const originalReading = await page.evaluate(() => ({
                ids: [...globalThis.document.querySelectorAll('.msg-item')].map(
                    (element) => element.id
                ),
                filters: globalThis.document.querySelector('#filterBar').textContent,
                noise: globalThis.document.querySelector('#noiseCount').textContent,
                top: globalThis.document.querySelector('#messages').scrollTop,
                date: globalThis.document.querySelector('#readingDate').textContent,
                results: [...globalThis.document.querySelectorAll('.sr-row')].map(
                    (element) => element.textContent
                ),
            }));
            const readBefore = await savedPosition();
            await shot('search');
            await page.click('.sr-row:nth-child(71)');
            await page.waitForSelector('#msg-synthetic-alpha-2026-09-21-19');
            await page.waitForSelector('#msg-synthetic-alpha-2026-09-21-19.msg-flash');
            const lostSearch = await page.evaluate(() => ({
                query: globalThis.document.querySelector('#searchInput').value,
                payload: globalThis.document.querySelector('#searchAllHint').dataset.payload,
                returnExists: !!globalThis.document.querySelector('#taskReturnButton'),
            }));
            if (reproduce) {
                assert.equal(lostSearch.query, '');
                assert.equal(lostSearch.payload, '');
                assert.equal(lostSearch.returnExists, false);
                console.log(`REPRO ${width} search`, JSON.stringify(lostSearch));
                await shot('search-source');
            } else {
                await page.waitForSelector('#taskReturnButton', { visible: true });
                assert.match(
                    await page.$eval('#taskReturnButton', (element) => element.textContent),
                    /返回搜索结果/
                );
                assert.equal(await savedPosition(), readBefore);
                await shot('search-source');
                const searchCalls = calls.search;
                await page.evaluate(() => globalThis.openContext('synthetic-alpha-2026-09-21-19'));
                await page.waitForSelector('#taskReturnPanelButton', { visible: true });
                await shot('source-context-return');
                await page.click('#taskReturnPanelButton');
                await page.waitForFunction('readingTask === null');
                await page.waitForFunction(
                    () =>
                        globalThis.document.querySelector('#researchPanel').dataset.view ===
                            'search' &&
                        globalThis.document
                            .querySelector('#researchPanel')
                            .classList.contains('open')
                );
                assert.equal(await page.$eval('#searchInput', (element) => element.value), '部署');
                assert.equal(await page.$eval('#searchScope', (element) => element.value), 'all');
                assert.equal(await page.$$eval('.sr-row', (elements) => elements.length), 120);
                assert.equal(
                    await page.$eval('.sr-list', (element) => element.scrollTop),
                    before.top
                );
                assert.equal(calls.search, searchCalls);
                assert.deepEqual(
                    await page.$$eval('.sr-row', (elements) =>
                        elements.map((element) => element.textContent)
                    ),
                    originalReading.results
                );
                assert.deepEqual(
                    await page.$$eval('.msg-item', (elements) =>
                        elements.map((element) => element.id)
                    ),
                    originalReading.ids
                );
                assert.equal(
                    await page.$eval('#filterBar', (element) => element.textContent),
                    originalReading.filters
                );
                assert.equal(
                    await page.$eval('#noiseCount', (element) => element.textContent),
                    originalReading.noise
                );
                assert.equal(
                    await page.$eval('#messages', (element) => element.scrollTop),
                    originalReading.top
                );
                console.log(
                    `PASS ${width} restored position`,
                    JSON.stringify({
                        readingTop: originalReading.top,
                        resultsTop: before.top,
                        rows: 120,
                        extraSearchCalls: calls.search - searchCalls,
                    })
                );
                assert.equal(
                    await page.$eval('#readingDate', (element) => element.textContent),
                    originalReading.date
                );
                assert.equal(
                    await page.evaluate(
                        () =>
                            globalThis.document.activeElement ===
                            globalThis.document.querySelectorAll('.sr-row')[70]
                    ),
                    true
                );
                await shot('search-return');
                await page.click('#searchMoreBtn');
                await page.waitForFunction(
                    () => globalThis.document.querySelectorAll('.sr-row').length === 135
                );
                assert.equal(calls.search, searchCalls + 1);
                await page.click('.sr-row:nth-child(71)');
                await page.waitForSelector('#taskReturnButton', { visible: true });
                await page.waitForFunction(() =>
                    globalThis.document
                        .querySelector('#messages')
                        .dataset.location.includes('2026-09-21')
                );
                failReturn = true;
                await page.click('#taskReturnButton');
                await page.waitForFunction(() =>
                    globalThis.document
                        .querySelector('#taskReturnStatus')
                        .textContent.includes('返回失败')
                );
                assert.equal(await savedPosition(), readBefore);
                assert.equal(
                    await page.$eval('#messages', (element) => element.dataset.location),
                    JSON.stringify([groups[0].id, dates[1]])
                );
                assert.equal(await page.$$eval('.msg-item', (elements) => elements.length), 45);
                assert.match(
                    await page.$eval('#readingDate', (element) => element.textContent),
                    /09 \/ 21/
                );
                failReturn = false;
                await page.click('#taskReturnButton');
                await page.waitForFunction('readingTask === null');
                await page.waitForSelector('.sr-row:nth-child(135)');
                assert.equal(calls.search, searchCalls + 1);
                await page.click('#researchPanel > .research-header .ctx-close');
                await page.select('#searchScope', 'day');
                await page.waitForSelector('.sr-row:nth-child(45)');
                const daySearchCalls = calls.search;
                await page.click('.sr-row:nth-child(12)');
                await page.waitForSelector('#taskReturnButton', { visible: true });
                await page.click('#taskReturnButton');
                await page.waitForFunction('readingTask === null');
                await page.waitForSelector('.sr-row:nth-child(45)');
                assert.equal(await page.$eval('#searchScope', (element) => element.value), 'day');
                assert.equal(calls.search, daySearchCalls);
                await page.click('#researchPanel > .research-header .ctx-close');
                await page.select('#searchScope', 'all');
                await page.waitForSelector('.sr-row:nth-child(60)');
                await page.click('#searchMoreBtn');
                await page.waitForSelector('.sr-row:nth-child(120)');
                holdSource = true;
                const pending = page.waitForRequest((request) =>
                    request.url().includes('/api/messages?date=2026-09-21')
                );
                await page.click('.sr-row:nth-child(71)');
                await pending;
                await page.click('#groupPickerToggle');
                await page.click('.archive-group:nth-child(2)');
                await page.waitForSelector('#msg-synthetic-beta-2026-09-22-0');
                await releaseSource();
                holdSource = false;
                await page.evaluate(
                    () => new Promise((resolve) => globalThis.requestAnimationFrame(resolve))
                );
                assert.equal(await visible('#taskReturnBar'), false);
                assert.equal(await page.$eval('#searchInput', (element) => element.value), '');
                await page.click('#groupPickerToggle');
                await page.click('.archive-group:first-child');
                await page.waitForSelector('#msg-synthetic-alpha-2026-09-22-0');
            }
            await page.reload({ waitUntil: 'networkidle0' });
            await page.waitForSelector('.msg-item');
            await page.click('#qaToggle');
            await page.waitForSelector('#qaQuickPanel.show');
            await page.type('#qaInput', '部署方案最后怎么定的？');
            await page.click('#qaSendBtn');
            await page.waitForSelector('.qa-source-item');
            await page.click('.qa-sources summary');
            const answerBefore = await page.$eval('#qaAnswer', (element) => element.innerHTML);
            const aiBefore = calls.qa;
            const aiReadingBefore = await savedPosition();
            const answerScroll = await page.$eval('#researchAi', (element) => {
                element.scrollTop = element.scrollHeight;
                return element.scrollTop;
            });
            await shot('ai');
            await page.click('.qa-source-item');
            await page.waitForSelector('#msg-synthetic-alpha-2026-09-20-12');
            await page.waitForSelector('#msg-synthetic-alpha-2026-09-20-12.msg-flash');
            const lostAi = await page.evaluate(() => ({
                question: globalThis.document.querySelector('#qaInput').value,
                answer: globalThis.document.querySelector('#qaAnswer').innerHTML,
            }));
            if (reproduce) {
                assert.equal(lostAi.question, '');
                assert.equal(lostAi.answer, '');
                console.log(`REPRO ${width} ai`, JSON.stringify(lostAi));
                await shot('ai-source');
            } else {
                await page.waitForSelector('#taskReturnButton', { visible: true });
                assert.match(
                    await page.$eval('#taskReturnButton', (element) => element.textContent),
                    /返回AI回答/
                );
                await shot('ai-source');
                await page.click('#taskReturnButton');
                await page.waitForFunction('readingTask === null');
                await page.waitForFunction(
                    () =>
                        globalThis.document.querySelector('#qaAnswerWrap').style.display !== 'none'
                );
                assert.equal(
                    await page.$eval('#qaInput', (element) => element.value),
                    '部署方案最后怎么定的？'
                );
                assert.equal(
                    await page.$eval('#qaAnswer', (element) => element.innerHTML),
                    answerBefore
                );
                assert.equal(
                    await page.$eval('.qa-sources details', (element) => element.open),
                    true
                );
                assert.equal(calls.qa, aiBefore);
                console.log(
                    `PASS ${width} restored AI`,
                    JSON.stringify({
                        qaRequests: calls.qa,
                        extraQaCalls: calls.qa - aiBefore,
                        questionRestored: true,
                        answerHtmlIdentical: true,
                    })
                );
                assert.equal(
                    await page.$eval('#researchAi', (element) => element.scrollTop),
                    answerScroll
                );
                assert.equal(await savedPosition(), aiReadingBefore);
                await shot('ai-return');
                await page.click('.qa-source-item');
                await page.waitForSelector('#taskReturnButton', { visible: true });
                await page.click('#qaToggle');
                await page.waitForFunction('readingTask === null');
                await page.waitForSelector('.qa-source-item');
                assert.equal(
                    await page.$eval('#qaAnswer', (element) => element.innerHTML),
                    answerBefore
                );
                assert.equal(calls.qa, aiBefore);
                await page.click('.qa-source-item');
                await page.waitForSelector('#taskReturnButton', { visible: true });
                await page.click('#groupPickerToggle');
                await page.click('.archive-group:nth-child(2)');
                await page.waitForSelector('#msg-synthetic-beta-2026-09-22-0');
                assert.equal(await visible('#taskReturnBar'), false);
                assert.equal(await page.$eval('#qaAnswer', (element) => element.innerHTML), '');
                assert.equal(await page.$eval('#searchInput', (element) => element.value), '');
            }
            assert.equal(calls.external, 0);
            assert.deepEqual(errors, []);
            assert.equal(
                await page.evaluate(
                    () => globalThis.document.body.scrollWidth <= globalThis.innerWidth
                ),
                true
            );
            results.push({
                width,
                status: reproduce ? 'both-losses-reproduced' : 'PASS',
                motion: normalMotion ? 'normal' : 'reduced',
                calls,
                errors,
            });
            console.log(
                `${reproduce ? 'REPRO' : 'PASS'} ${width}:`,
                JSON.stringify(results.at(-1))
            );
            await context.close();
        }
        fs.writeFileSync(
            path.join(
                artifacts,
                reproduce
                    ? 'reproduction.json'
                    : normalMotion
                      ? 'verification-normal-motion.json'
                      : 'verification.json'
            ),
            JSON.stringify(results, null, 2) + '\n'
        );
    } finally {
        if (browser) await browser.close();
        await new Promise((resolve) => server.close(resolve));
    }
}
main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
