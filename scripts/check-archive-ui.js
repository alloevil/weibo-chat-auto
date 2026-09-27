'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const puppeteer = require('puppeteer');
const { resolveChromePath } = require('../lib/chrome-path');
const { uniqueGroupKey, writeGroupMetadata } = require('../lib/group-storage');
const { writeRegistry } = require('../lib/group-registry');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'weibo-archive-ui-'));
const artifacts = path.join(__dirname, '..', 'output', 'playwright');
const groups = [
    {
        name: '开源茶馆 · 产品与技术',
        id: '990001',
        dates: ['2026-09-20', '2026-09-21', '2026-09-22'],
    },
    { name: '周末读书会', id: '990002', dates: ['2026-09-23'] },
    { name: '产品体验讨论组', id: '990003', dates: ['2026-09-24'] },
];
const users = ['林青禾', '半夏', '阿渡', '小林'];
const avatarUrls = users.map((_, index) =>
    index % 2 === 0
        ? `https://example.invalid/avatars/${index + 1}.jpg`
        : `https://wx1.sinaimg.cn/avatars/${index + 1}.jpg`
);
const lines = [
    '周末整理了一下群里的讨论，发现很多有用的信息都被后来的消息淹没了。',
    '归档应该先让人读得舒服，再让人找到需要的东西。',
    '上次的方案讨论，有人记得最后怎么决定的吗？',
    '我们选了本地归档，先做好历史检索和原文追溯。',
    '这个方向很好。工具不应该让大家再学一套复杂的操作。',
    '我把安装步骤整理成文档了，等会儿发出来。',
    '时间线可以按天浏览，搜索结果点一下就回到消息的位置。',
    '希望输入框不会在看历史的时候一直出现，容易误发。',
    '收到，先保证阅读和检索的体验。',
    '一条稍长的测试记录：我们需要同时考虑桌面和手机上的阅读。窄屏时，导航和辅助面板应该按需打开，而不是把正文挤成细细的一列。',
    'https://example.invalid/notes/archive-reader',
    '明天继续，今天先把讨论的结论归档。',
];

function fixture() {
    fs.mkdirSync(path.join(root, 'cache'), { recursive: true });
    fs.mkdirSync(artifacts, { recursive: true });
    fs.writeFileSync(
        path.join(root, 'config.json'),
        JSON.stringify({ groups: groups.map((group) => group.name) })
    );
    fs.writeFileSync(
        path.join(root, 'cache', 'emotions.json'),
        JSON.stringify({ fetchedAt: Date.now(), map: {} })
    );
    const registry = { schemaVersion: 1, groups: [] };
    groups.forEach((group, groupIndex) => {
        group.key = uniqueGroupKey(group.name);
        const directory = path.join(root, 'output', group.key);
        fs.mkdirSync(directory, { recursive: true });
        writeGroupMetadata(directory, {
            groupName: group.name,
            groupId: group.id,
            storageKey: group.key,
        });
        group.dates.forEach((date, dateIndex) => {
            const messages = lines.map((content, index) => ({
                id: `${group.id}${dateIndex}${String(index).padStart(3, '0')}`,
                user: users[index % users.length],
                from_uid: String(100 + (index % users.length)),
                avatar: avatarUrls[index % users.length],
                content: groupIndex ? `读书笔记：${content}` : content,
                time: `${date.replaceAll('-', '/')} 09:${String(index * 4).padStart(2, '0')}:00`,
                timestamp: Date.parse(`${date}T09:00:00+08:00`) + index * 240000,
                date,
                pics: [],
            }));
            fs.writeFileSync(
                path.join(directory, `weibo_chat_${date}.json`),
                JSON.stringify(messages)
            );
        });
        registry.groups.push({
            groupName: group.name,
            groupId: group.id,
            storageKey: group.key,
            updatedAt: '2026-09-23T00:00:00Z',
        });
    });
    writeRegistry(path.join(root, 'state', 'group-registry.json'), registry);
}

async function main() {
    fixture();
    process.env.WEIBO_DATA_ROOT = root;
    process.env.WEIBO_COOKIE_FILE = path.join(root, 'cookies.json');
    process.env.NO_OPEN = '1';
    const { createViewerServer } = require('./viewer-server');
    const server = createViewerServer();
    let browser;
    const passed = [];
    const record = (name) => {
        passed.push(name);
        console.log(`PASS ${name}`);
    };
    try {
        await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
        const base = `http://127.0.0.1:${server.address().port}`;
        browser = await puppeteer.launch({
            executablePath: resolveChromePath(process.env.CHROME_PATH || ''),
            headless: true,
            args: ['--no-sandbox'],
        });
        const page = await browser.newPage();
        await page.evaluateOnNewDocument(() => {
            globalThis.__notificationCalls = [];
            globalThis.__permissionCalls = 0;
            globalThis.Notification = class {
                static permission = 'granted';
                static async requestPermission() {
                    globalThis.__permissionCalls++;
                    return 'granted';
                }
                constructor(title, options) {
                    globalThis.__notificationCalls.push({ title, options });
                }
            };
            globalThis.EventSource = class {
                constructor() {
                    globalThis.__archiveEventSource = this;
                }
                close() {}
            };
        });
        await page.setViewport({ width: 1440, height: 960 });
        const errors = [];
        page.on('pageerror', (error) => errors.push(error.message));
        let configured = false;
        let emptyArchive = false;
        let failSearch = false;
        let releaseSearch;
        let holdSearch = false;
        let sends = 0;
        let archiveUpdates = false;
        let longHistory = false;
        let scaledGroups = null;
        let compactFixture = false;
        let positionFixture = false;
        let heldPositionReply;
        let holdPositionGroup = '';
        const positionData = new Map();
        for (const [groupIndex, group] of groups.entries()) {
            const dates = {};
            for (const date of ['2026-08-10', '2026-09-26']) {
                dates[date] = Array.from({ length: 40 }, (_, index) => ({
                    id: `resume-${groupIndex}-${date}-${index}`,
                    date,
                    user: users[index % users.length],
                    from_uid: String(index % users.length),
                    avatar: avatarUrls[index % users.length],
                    content: `第 ${index + 1} 条合成阅读记录。切群后应当回到这一条，而不是依赖固定像素。`,
                    timestamp: Date.parse(`${date}T09:00:00+08:00`) + index * 60000,
                    time: `${date.replaceAll('-', '/')} 09:${String(index).padStart(2, '0')}:00`,
                    pics: [],
                }));
            }
            positionData.set(group.key, dates);
        }
        const longText =
            '我们最终选择本地归档。先保证消息可以检索、引用可以追溯，再考虑更多功能。'.repeat(9);
        const compactMessages = [
            { user: '林青禾', from_uid: '1', minute: 0, content: '今天先讨论消息阅读体验。' },
            { user: '林青禾', from_uid: '1', minute: 1, content: '短消息可以更紧凑。' },
            { user: '林青禾', from_uid: '1', minute: 2, content: '但每条消息都要保留原始位置。' },
            { user: '半夏', from_uid: '2', minute: 3, content: '赞同，别把连续发言拆得太散。' },
            { user: '阿渡', from_uid: '3', minute: 4, content: longText },
            {
                user: '半夏',
                from_uid: '2',
                minute: 5,
                content: `「${longText}」 - - - - - - - - - - - - - - - 收到，就按这个结论推进。`,
            },
            {
                user: '小林',
                from_uid: '4',
                minute: 6,
                content: '这里是一张合成示意图。',
                pics: ['https://example.invalid/compact-image.png'],
            },
            {
                user: '小林',
                from_uid: '4',
                minute: 7,
                content: 'https://example.invalid/' + 'reference-'.repeat(40),
            },
            { user: '同名成员', from_uid: '5', minute: 8, content: '我是第一个同名成员。' },
            { user: '同名成员', from_uid: '6', minute: 9, content: '我是另一个成员，不应合并。' },
            { user: '半夏', from_uid: '2', minute: 45, content: '继续之前的讨论。' },
        ].map((message, index) => ({
            ...message,
            id: `compact-${index}`,
            date: '2026-09-26',
            time: `2026/09/26 09:${String(message.minute).padStart(2, '0')}:23`,
            timestamp: Date.parse('2026-09-26T09:00:23+08:00') + message.minute * 60000,
            pics: message.pics || [],
            avatar: avatarUrls[users.indexOf(message.user)] || '',
        }));
        const historyCounts = Object.fromEntries(
            Array.from({ length: 1000 }, (_, index) => [
                new Date(Date.UTC(2024, 0, 1 + index)).toISOString().slice(0, 10),
                1,
            ])
        );
        const historyMessage = (date) => ({
            id: `history-${date}`,
            date,
            user: '半夏',
            content: `${date} 的合成归档：长历史日期导航测试。`,
            time: `${date.replaceAll('-', '/')} 09:00:00`,
            timestamp: Date.parse(`${date}T09:00:00+08:00`),
            pics: [],
        });
        let archiveStamp = Date.parse('2026-09-26T14:00:00+08:00');
        const extraMessages = {};
        const avatarRequests = new Set();
        const avatarSamples = avatarUrls.map((_, index) => {
            const colors = ['#7599b6', '#8c9c79', '#b49a77', '#a68b9e'];
            return `<svg xmlns="http://www.w3.org/2000/svg" width="128" height="128" viewBox="0 0 128 128"><rect width="128" height="128" fill="${colors[index]}"/><circle cx="64" cy="45" r="25" fill="#e7ddd0"/><path d="M16 128v-8a48 48 0 0 1 96 0v8" fill="#354052"/><circle cx="55" cy="45" r="3" fill="#354052"/><circle cx="73" cy="45" r="3" fill="#354052"/><path d="M54 57q10 8 20 0" fill="none" stroke="#354052" stroke-width="3"/></svg>`;
        });
        await page.setRequestInterception(true);
        page.on('request', (request) => {
            const url = new URL(request.url());
            const reply = (body) =>
                request.respond({ contentType: 'application/json', body: JSON.stringify(body) });
            const avatarSource =
                url.pathname === '/api/sinaimg' ? url.searchParams.get('url') : url.href;
            const avatarIndex = avatarUrls.indexOf(avatarSource);
            if (avatarIndex !== -1) {
                avatarRequests.add(url.pathname === '/api/sinaimg' ? 'proxy' : 'direct');
                return request.respond({
                    contentType: 'image/svg+xml',
                    body: avatarSamples[avatarIndex],
                });
            }
            if (url.href === 'https://example.invalid/avatars/broken.jpg') {
                return request.respond({
                    status: 404,
                    contentType: 'text/plain',
                    body: 'synthetic missing avatar',
                });
            }
            if (url.href === 'https://example.invalid/compact-image.png')
                return request.respond({
                    contentType: 'image/svg+xml',
                    body: '<svg xmlns="http://www.w3.org/2000/svg" width="480" height="240"><rect width="480" height="240" fill="#e7efe8"/><rect x="30" y="30" width="120" height="180" rx="12" fill="#397366"/><path d="M180 65h240M180 110h190M180 155h220" stroke="#94b1a3" stroke-width="16"/><text x="180" y="215" font-size="18" fill="#285c50">SYNTHETIC FIXTURE</text></svg>',
                });
            if (url.origin !== base) return request.abort();
            if (positionFixture && positionData.has(url.searchParams.get('group'))) {
                const group = url.searchParams.get('group');
                const dates = positionData.get(group);
                if (url.pathname === '/api/dates')
                    return reply({
                        dates: Object.fromEntries(
                            Object.entries(dates).map(([date, messages]) => [date, messages.length])
                        ),
                    });
                if (url.pathname === '/api/messages') {
                    const payload = { messages: dates[url.searchParams.get('date')] || [] };
                    if (group === holdPositionGroup) {
                        heldPositionReply = () => reply(payload);
                        return;
                    }
                    return reply(payload);
                }
            }
            if (compactFixture) {
                if (url.pathname === '/api/dates')
                    return reply({ dates: { '2026-09-26': compactMessages.length } });
                if (url.pathname === '/api/messages') return reply({ messages: compactMessages });
            }
            if (emptyArchive && url.pathname === '/api/groups') return reply({ groups: [] });
            if (emptyArchive && url.pathname === '/api/dates') return reply({ dates: {} });
            if (scaledGroups) {
                if (url.pathname === '/api/groups') return reply({ groups: scaledGroups });
                if (url.pathname === '/api/dates') return reply({ dates: { '2026-09-26': 1 } });
                if (url.pathname === '/api/messages')
                    return reply({
                        messages: [
                            {
                                ...historyMessage('2026-09-26'),
                                id: `scaled-${url.searchParams.get('group')}`,
                                content: `合成群 ${url.searchParams.get('group')} 的记录`,
                            },
                        ],
                    });
            }
            if (longHistory && url.searchParams.get('group') === groups[0].key) {
                if (url.pathname === '/api/dates') return reply({ dates: historyCounts });
                if (url.pathname === '/api/messages')
                    return reply({ messages: [historyMessage(url.searchParams.get('date'))] });
                if (url.pathname === '/api/search')
                    return reply({
                        ok: true,
                        total: 1,
                        byDate: [{ date: '2024-02-29', count: 1 }],
                        hits: [{ ...historyMessage('2024-02-29'), preview: '闰日讨论的归档记录' }],
                    });
            }
            if (archiveUpdates && url.pathname === '/api/groups') {
                fetch(request.url())
                    .then((response) => response.json())
                    .then((data) => reply({ ...data, lastArchived: archiveStamp }));
                return;
            }
            if (archiveUpdates && ['/api/dates', '/api/messages'].includes(url.pathname)) {
                fetch(request.url())
                    .then((response) => response.json())
                    .then((data) => {
                        if (url.searchParams.get('group') !== groups[0].key) return reply(data);
                        if (url.pathname === '/api/dates') {
                            for (const [date, messages] of Object.entries(extraMessages))
                                data.dates[date] = (data.dates[date] || 0) + messages.length;
                        } else
                            data.messages.push(
                                ...(extraMessages[url.searchParams.get('date')] || [])
                            );
                        return reply(data);
                    });
                return;
            }
            if (url.pathname === '/api/auth-status') return reply({ ok: true });
            if (url.pathname === '/api/version') return reply({ ok: true, updateAvailable: false });
            if (url.pathname === '/api/sync') return reply({ ok: true, archived: 1 });
            if (url.pathname === '/api/ai-config')
                return reply({
                    ok: true,
                    configured,
                    missingFields: configured ? [] : ['baseUrl', 'apiKey', 'model'],
                    config: configured
                        ? {
                              baseUrl: 'https://example.invalid',
                              apiKey: 'synthetic',
                              model: 'synthetic',
                          }
                        : null,
                });
            if (url.pathname === '/api/qa')
                return reply({
                    ok: true,
                    answer: '这是合成回答：优先做好历史检索与原文追溯。',
                    sources: [
                        {
                            date: '2026-09-20',
                            id: `${groups[0].id}0003`,
                            user: '小林',
                            preview: lines[3],
                        },
                    ],
                });
            if (url.pathname === '/api/summary')
                return reply({
                    ok: true,
                    summary: '## 合成摘要\n\n- 群内讨论了本地归档与阅读体验。',
                    cached: false,
                });
            if (url.pathname === '/api/send' || url.pathname === '/api/send-image') {
                sends++;
                return reply({ ok: true });
            }
            if (url.pathname === '/api/search' && holdSearch) {
                releaseSearch = () => reply({ ok: true, hits: [], byDate: [], total: 0 });
                return;
            }
            if (url.pathname === '/api/search' && failSearch) return reply({ ok: false });
            return request.continue();
        });
        const visible = (selector) =>
            page.$eval(selector, (element) => !!(element.offsetWidth || element.offsetHeight));
        const shot = (name) => page.screenshot({ path: path.join(artifacts, name) });
        const assertPhotoAvatars = async (expected) => {
            await page.waitForFunction(() =>
                [...globalThis.document.querySelectorAll('.msg-avatar img')].every(
                    (image) => image.complete && image.naturalWidth === 128
                )
            );
            const photos = await page.$$eval('.msg-avatar img', (images) =>
                images.map((image) => {
                    const box = image.getBoundingClientRect();
                    return {
                        width: box.width,
                        height: box.height,
                        src: image.getAttribute('src'),
                        fit: globalThis.getComputedStyle(image).objectFit,
                    };
                })
            );
            assert.equal(photos.length, expected);
            assert.ok(
                photos.every(
                    (photo) => photo.width >= 24 && photo.height >= 24 && photo.fit === 'cover'
                )
            );
            assert.equal(new Set(photos.map((photo) => photo.src)).size, 4);
        };
        const chooseGroup = async (selector) => {
            if (!(await visible('#groupPickerOverlay'))) await page.click('#groupPickerToggle');
            await page.click(selector);
        };
        const openDates = async () => {
            if (!(await visible('#archiveNav'))) await page.click('#archiveNavToggle');
        };
        const clickDateControl = async (selector) => {
            await openDates();
            await page.click(selector);
        };
        const search = async (query) => {
            if (await visible('#archiveNav')) await page.click('#dateDrawerClose');
            await page.click('#searchInput', { clickCount: 3 });
            await page.type('#searchInput', query);
        };
        await page.goto(base, { waitUntil: 'networkidle0' });
        await page.waitForSelector('.archive-day.active');
        await page.waitForSelector('.msg-item');
        assert.equal(
            await page.$$eval('.msg-avatar img', (images) => images.length),
            12,
            '截图样本必须覆盖图像头像，不能全部退回首字'
        );
        await assertPhotoAvatars(12);
        assert.deepEqual([...avatarRequests].sort(), ['direct', 'proxy']);
        assert.equal(
            await page.$eval(
                '.msg-avatar',
                (element) => globalThis.getComputedStyle(element).borderRadius
            ),
            '50%'
        );
        record('12 条截图样本图像头像全部加载，4 人头像一致，直链和 sinaimg 代理路径均覆盖');
        assert.equal(await page.$$eval('.archive-group', (elements) => elements.length), 3);
        assert.equal(await page.$$eval('.archive-day', (elements) => elements.length), 3);
        assert.equal(await visible('#composer'), false);
        await shot('archive-desktop.png');
        assert.equal(await visible('#archiveNav'), false);
        assert.equal(
            await page.$eval('.workspace', (element) => element.getBoundingClientRect().left),
            0
        );
        assert.equal(await visible('#groupPickerOverlay'), false);
        assert.equal(
            await page.$eval('#groupPickerLabel', (element) => element.textContent),
            groups[0].name
        );
        await shot('selector-desktop.png');
        await shot('graphite-production-desktop.png');
        await shot('graphite-avatars-desktop.png');
        const chromeRatios = await page.evaluate(() => {
            const pairs = [
                ['#groupPickerToggle', '.group-bar'],
                ['#searchInput', '#navSearch'],
                ['#searchInput', '#navSearch', '::placeholder'],
                ['#searchScope', '#navSearch'],
                ['#syncBtn', '.nav-top'],
                ['#qaToggle', '.nav-tools'],
                ['#archiveFreshness', '.archive-freshness'],
                ['#readingDate', '.nav-tools'],
            ];
            const background = (element) => {
                while (element) {
                    const color = globalThis.getComputedStyle(element).backgroundColor;
                    if (color !== 'rgba(0, 0, 0, 0)' && color !== 'transparent') return color;
                    element = element.parentElement;
                }
                return 'rgb(255, 255, 255)';
            };
            const luminance = (color) => {
                const values = color
                    .match(/[\d.]+/g)
                    .slice(0, 3)
                    .map((value) => Number(value) / 255)
                    .map((value) =>
                        value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4
                    );
                return values[0] * 0.2126 + values[1] * 0.7152 + values[2] * 0.0722;
            };
            return pairs.map(([selector, surface, pseudo]) => {
                const front = luminance(
                    globalThis.getComputedStyle(globalThis.document.querySelector(selector), pseudo)
                        .color
                );
                const back = luminance(background(globalThis.document.querySelector(surface)));
                return {
                    selector,
                    pseudo,
                    ratio: (Math.max(front, back) + 0.05) / (Math.min(front, back) + 0.05),
                };
            });
        });
        for (const sample of chromeRatios)
            assert.ok(
                sample.ratio >= 4.5,
                `${sample.selector} ${sample.pseudo || ''}: ${sample.ratio}`
            );
        record(
            `正式深色工具区 8 个对比度样本 ≥4.5:1，最低 ${Math.min(...chromeRatios.map((sample) => sample.ratio)).toFixed(2)}:1`
        );
        const readingContrast = await page.evaluate(() => {
            const styles = globalThis.getComputedStyle(globalThis.document.documentElement);
            const luminance = (token) => {
                const hex = styles.getPropertyValue(token).trim().slice(1);
                const values = [0, 2, 4]
                    .map((offset) => parseInt(hex.slice(offset, offset + 2), 16) / 255)
                    .map((value) =>
                        value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4
                    );
                return values[0] * 0.2126 + values[1] * 0.7152 + values[2] * 0.0722;
            };
            const background = luminance('--canvas');
            return Object.fromEntries(
                ['--ink', '--ink-muted', '--ink-subtle', '--primary'].map((token) => [
                    token,
                    (background + 0.05) / (luminance(token) + 0.05),
                ])
            );
        });
        for (const ratio of Object.values(readingContrast))
            assert.ok(ratio >= 4.5, `阅读区主要文字对比度 ${ratio}`);
        record(
            `阅读区主文字/辅助文字/强调色对比度均 ≥4.5:1，最低 ${Math.min(...Object.values(readingContrast)).toFixed(2)}:1`
        );
        await chooseGroup('.archive-group:nth-child(3)');
        await page.waitForSelector('#msg-9900030000');
        await chooseGroup('.archive-group:first-child');
        await page.waitForSelector('#msg-9900012000');
        await openDates();
        assert.equal(
            await page.$eval('.workspace', (element) => element.hasAttribute('inert')),
            true
        );
        await page.keyboard.press('Tab');
        await page.keyboard.down('Shift');
        await page.keyboard.press('Tab');
        await page.keyboard.up('Shift');
        assert.equal(
            await page.evaluate(() => globalThis.document.activeElement.id),
            'dateDrawerClose'
        );
        await page.keyboard.down('Shift');
        await page.keyboard.press('Tab');
        await page.keyboard.up('Shift');
        assert.equal(
            await page.evaluate(
                () => globalThis.document.activeElement.closest('#archiveNav') !== null
            ),
            true
        );
        await page.keyboard.press('Escape');
        assert.equal(await visible('#archiveNav'), false);
        assert.equal(
            await page.evaluate(() => globalThis.document.activeElement.id),
            'archiveNavToggle'
        );
        await openDates();
        await page.click('#archiveBackdrop', { offset: { x: 600, y: 300 } });
        assert.equal(await visible('#archiveNav'), false);
        record('统一群入口切换、默认无左栏、日期抽屉焦点限制与关闭恢复');
        record('默认群与历史导航、只读模式、桌面截图');

        await page.click('#composeToggle');
        assert.equal(await visible('#composer'), true);
        assert.match(
            await page.$eval('#composerHint', (element) => element.textContent),
            /实时群聊.*而非/
        );
        await page.type('#composerInput', '不应带到另一个群的草稿');
        await page.$eval('#messages', (element) => {
            element.scrollTop = 80;
        });
        const sameGroupScroll = await page.$eval('#messages', (element) => element.scrollTop);
        await chooseGroup('.archive-group[aria-current="page"]');
        assert.equal(await visible('#composer'), true);
        assert.equal(
            await page.$eval('#composerInput', (element) => element.value),
            '不应带到另一个群的草稿'
        );
        assert.equal(
            await page.$eval('#messages', (element) => element.scrollTop),
            sameGroupScroll
        );
        record('选择当前群只关闭选择器，保留发送草稿与阅读位置');
        await chooseGroup('.archive-group:nth-child(2)');
        await page.waitForFunction(
            () =>
                globalThis.document.querySelector('#archiveTitle').textContent === '周末读书会' &&
                globalThis.document.querySelector('#messages').textContent.includes('读书笔记')
        );
        assert.equal(await visible('#composer'), false);
        assert.equal(await page.$eval('#composerInput', (element) => element.value), '');
        await chooseGroup('.archive-group:first-child');
        await page.waitForFunction(
            () => globalThis.document.querySelectorAll('.archive-day').length === 3
        );
        record('切群更新正文、关闭发送并清除旧群草稿');

        await clickDateControl('.archive-day:last-child');
        await page.waitForFunction(() =>
            globalThis.document.querySelector('#readingDate').textContent.includes('20')
        );
        await clickDateControl('#dateToggle');
        assert.equal(await visible('#calendar'), true);
        await page.click('.cal-day[aria-label="2026-09-22"]');
        await page.waitForFunction(() =>
            globalThis.document.querySelector('#readingDate').textContent.includes('22')
        );
        record('日期列表与日历切换');

        await search('方案讨论');
        await page.waitForSelector('.sr-row');
        assert.equal(await page.$$eval('.sr-row', (elements) => elements.length), 3);
        await shot('archive-search.png');
        await page.click('.sr-row:last-child');
        await page.waitForFunction(() =>
            globalThis.document.querySelector('#readingDate').textContent.includes('20')
        );
        await page.waitForSelector('.msg-flash');
        assert.equal(await visible('#researchPanel'), false);
        record('全部日期检索、跨日回到原文与高亮');

        await page.select('#searchScope', 'day');
        await search('方案讨论');
        await page.waitForSelector('.sr-row');
        assert.equal(await page.$$eval('.sr-row', (elements) => elements.length), 1);
        await search('不存在的关键词');
        await page.waitForFunction(() =>
            globalThis.document.querySelector('#searchResults').textContent.includes('没有找到')
        );
        record('当前日期范围与无结果反馈');

        await page.click('#searchClear');
        await page.select('#searchScope', 'all');
        failSearch = true;
        await search('方案');
        await page.waitForFunction(() =>
            globalThis.document.querySelector('#searchResults').textContent.includes('检索失败')
        );
        failSearch = false;
        await page.focus('#searchInput');
        await page.keyboard.press('Enter');
        await page.waitForSelector('.sr-row');
        record('检索失败反馈与显式重试');

        await page.click('#searchClear');
        holdSearch = true;
        await search('待返回的旧群检索');
        await page.waitForRequest((request) => new URL(request.url()).pathname === '/api/search');
        assert.equal(typeof releaseSearch, 'function');
        await chooseGroup('.archive-group:nth-child(2)');
        await page.waitForFunction(
            () => globalThis.document.querySelector('#archiveTitle').textContent === '周末读书会'
        );
        await releaseSearch();
        holdSearch = false;
        assert.equal(await visible('#researchPanel'), false);
        await chooseGroup('.archive-group:first-child');
        await page.waitForSelector('.archive-day.active');
        record('切群后丢弃延迟返回的旧搜索结果');

        await page.waitForSelector('.msg-item');
        await page.hover('.msg-item');
        await page.click('.msg-ctx-btn');
        await page.waitForSelector('#contextPanel.open');
        assert.equal(
            await page.$eval('#researchPanel', (element) => element.dataset.view),
            'context'
        );
        await shot('archive-context.png');
        await shot('tabs-context.png');
        await shot('graphite-production-context.png');
        await assertPhotoAvatars(12);
        await shot('graphite-avatars-context.png');
        await page.click('#ctxDensityBtn');
        assert.equal(
            await page.$eval('#ctxDensityBtn', (element) => element.getAttribute('aria-pressed')),
            'true'
        );
        await page.keyboard.press('Escape');
        assert.equal(await visible('#researchPanel'), false);
        await page.click('#archiveMore summary');
        await page.click('#sidebarToggle');
        assert.equal(
            await page.$eval('#researchPanel', (element) => element.dataset.view),
            'members'
        );
        await page.click('.user-item');
        assert.equal(await visible('#filterBar'), true);
        await page.click('#userClear button');
        await page.keyboard.press('Escape');
        record('上下文、全文切换、成员筛选和关闭面板');

        await page.click('#qaToggle');
        await page.waitForSelector('#settingsModal.show');
        assert.match(
            await page.$eval('#aiConfigAlert', (element) => element.textContent),
            /API Key/
        );
        await page.keyboard.press('Escape');
        configured = true;
        await page.waitForFunction(() => {
            const toast = globalThis.document.querySelector('#toast');
            return (
                toast.getBoundingClientRect().top >= 0 &&
                globalThis.getComputedStyle(toast).opacity === '1'
            );
        });
        await page.click('#toast');
        await page.click('#qaToggle');
        await page.waitForSelector('#qaQuickPanel.show');
        await page.type('#qaInput', '最后决定了什么？');
        await page.click('#qaSendBtn');
        await page.waitForSelector('.qa-source-item');
        await page.click('#summaryBtn');
        await page.waitForSelector('#summaryContent.show');
        await shot('archive-ai.png');
        await page.click('.qa-sources summary');
        await page.click('.qa-source-item');
        await page.waitForFunction(() =>
            globalThis.document.querySelector('#readingDate').textContent.includes('20')
        );
        await page.waitForSelector('.msg-flash');
        record('AI 未配置引导、合成回答/摘要与来源追溯');

        await page.click('#archiveMore summary');
        await page.click('#statsToggle');
        await page.waitForSelector('#statsPanel.show');
        assert.equal(await page.$$eval('.stats-kpi', (elements) => elements.length), 4);
        await page.click('#archiveMore summary');
        await page.click('#statsToggle');
        await page.click('#archiveMore summary');
        await page.click('#exportToggle');
        assert.match(
            await page.$eval('#exportMd', (element) => element.href),
            /date=2026-09-20.*format=md/
        );
        await page.click('#archiveMore summary');
        record('统计与当前日期导出入口保留');

        for (const width of [1280, 900, 360]) {
            await page.setViewport({ width, height: 900 });
            assert.equal(
                await page.evaluate(
                    () => globalThis.document.body.scrollWidth <= globalThis.innerWidth
                ),
                true
            );
            await shot(`archive-${width}.png`);
        }
        await page.click('#archiveNavToggle');
        assert.equal(await visible('#archiveNav'), true);
        await shot('archive-mobile-navigation.png');
        await page.click('.archive-day:first-of-type');
        await page.waitForSelector('#msg-9900012000');
        assert.equal(await visible('#archiveNav'), false);
        await page.click('.msg-menu summary');
        await page.click('.msg-menu[open] button');
        assert.equal(await visible('#researchPanel'), true);
        await shot('archive-mobile-context.png');
        await page.keyboard.press('Escape');
        assert.equal(
            await page.$eval('.content', (element) => element.hasAttribute('inert')),
            false
        );
        record('1280/900/360px 无横向溢出、窄屏导航与面板关闭');
        await chooseGroup('.archive-group:nth-child(3)');
        await page.waitForSelector('#msg-9900030000');
        assert.equal(
            await page.evaluate(
                () => globalThis.document.body.scrollWidth <= globalThis.innerWidth
            ),
            true
        );
        await shot('selector-mobile.png');
        await shot('graphite-production-mobile.png');
        await assertPhotoAvatars(12);
        await shot('graphite-avatars-mobile.png');
        record('360px 消息图像头像全部可见且正确裁切');
        const searchFits = await page.evaluate(() => {
            const input = globalThis.document.querySelector('#searchInput').getBoundingClientRect();
            const outer = globalThis.document.querySelector('#navSearch').getBoundingClientRect();
            return (
                input.top >= outer.top && input.bottom <= outer.bottom && input.right <= outer.right
            );
        });
        assert.equal(searchFits, true, '手机搜索输入框必须位于搜索容器内部');
        await chooseGroup('.archive-group:first-child');
        await page.waitForSelector('#msg-9900012000');
        await page.click('#archiveNavToggle');
        await page.click('#dateDrawerClose');
        await page.click('#settingsBtn');
        assert.equal(
            await page.$eval('#settingsModal', (element) => !!element.closest('[inert]')),
            false
        );
        await page.select('#themeSelect', 'archive');
        await page.keyboard.press('Escape');
        record('窄屏导航进入设置后仍可交互');

        await page.click('#archiveNavToggle');
        await page.setViewport({ width: 1280, height: 900 });
        await page.waitForFunction(
            () => !globalThis.document.querySelector('#archiveNav').classList.contains('open')
        );
        assert.equal(
            await page.$eval('.workspace', (element) => element.hasAttribute('inert')),
            false
        );
        record('导航打开时从窄屏拉宽，恢复主界面交互');
        await page.click('#settingsBtn');
        for (const theme of ['', 'qq2000', 'qq2008', 'qq2012', 'archive']) {
            await page.select('#themeSelect', theme);
            assert.equal(await page.$eval('html', (element) => element.dataset.theme || ''), theme);
        }
        await page.keyboard.press('Escape');
        assert.deepEqual(errors, []);
        assert.equal(sends, 0);
        assert.equal(
            await page.evaluate(() => {
                const ids = [...globalThis.document.querySelectorAll('[id]')].map(
                    (element) => element.id
                );
                return ids.length === new Set(ids).size;
            }),
            true
        );
        record('主题兼容、无重复 DOM id、无页面异常、零真实发送/模型调用');
        await chooseGroup('.archive-group:first-child');
        await page.waitForSelector('#msg-9900012000');
        await shot('reading-before.png');
        archiveUpdates = true;
        await page.setViewport({ width: 1280, height: 700 });
        await page.evaluate(() => globalThis.checkForUpdates());
        await page.evaluate(
            () => new Promise((resolve) => globalThis.requestAnimationFrame(resolve))
        );
        await page.$eval('#messages', (element) => {
            element.scrollTop = 150;
        });
        const readingTop = await page.$eval('#messages', (element) => element.scrollTop);
        const newMessage = (date, index) => ({
            id: `new-${date}-${index}`,
            user: '半夏',
            content: `新增归档记录 ${index}`,
            date,
            time: `${date.replaceAll('-', '/')} 23:00:00`,
            timestamp: Date.parse(`${date}T23:00:00+08:00`) + index,
            pics: [],
        });
        extraMessages['2026-09-22'] = [newMessage('2026-09-22', 1), newMessage('2026-09-22', 2)];
        archiveStamp++;
        await page.evaluate(() => globalThis.checkForUpdates());
        await page.waitForFunction(
            () => globalThis.document.querySelector('#messages').scrollTop === 150
        );
        assert.equal(await page.$eval('#messages', (element) => element.scrollTop), readingTop);
        assert.match(
            await page.$eval('#newArchiveBtn', (element) => element.textContent),
            /新增 2 条/
        );
        archiveStamp++;
        await page.evaluate(() => globalThis.checkForUpdates());
        assert.match(
            await page.$eval('#newArchiveBtn', (element) => element.textContent),
            /新增 2 条/
        );
        await shot('reading-new-messages.png');
        await page.click('#newArchiveBtn');
        await page.waitForFunction(() => {
            const element = globalThis.document.querySelector('#messages');
            return element.scrollHeight - element.clientHeight - element.scrollTop < 2;
        });
        assert.equal(await visible('#newArchiveBtn'), false);
        record('同日新增保留滚动位置、重复刷新不重计、点击提示到底');

        await page.$eval('#messages', (element) => {
            element.scrollTop = 120;
        });
        extraMessages['2026-09-24'] = [newMessage('2026-09-24', 1)];
        archiveStamp++;
        await page.evaluate(() => globalThis.checkForUpdates());
        assert.match(await page.$eval('#readingDate', (element) => element.textContent), /22/);
        assert.equal(await page.$eval('#messages', (element) => element.scrollTop), 120);
        assert.match(
            await page.$eval('#newArchiveBtn', (element) => element.textContent),
            /新增 1 条/
        );
        await page.click('#latestArchiveBtn');
        await page.waitForSelector('[id="msg-new-2026-09-24-1"]');
        assert.match(await page.$eval('#readingDate', (element) => element.textContent), /24/);
        assert.equal(await visible('#newArchiveBtn'), false);
        await clickDateControl('.archive-day:last-child');
        await page.waitForSelector('#msg-9900010000');
        await page.click('#dayBottomBtn');
        await page.waitForFunction(() => {
            const element = globalThis.document.querySelector('#messages');
            return element.scrollHeight - element.clientHeight - element.scrollTop < 2;
        });
        assert.match(await page.$eval('#readingDate', (element) => element.textContent), /20/);
        record('跨日不自动跳转、最新归档显式跳转、当天底部不切日期');

        await chooseGroup('.archive-group:nth-child(2)');
        await page.waitForSelector('#msg-9900020000');
        assert.equal(await visible('#newArchiveBtn'), false);
        await chooseGroup('.archive-group:first-child');
        await page.waitForSelector('#msg-9900010000');
        assert.match(await page.$eval('#readingDate', (element) => element.textContent), /20/);
        await clickDateControl('.archive-day:nth-of-type(3)');
        await page.waitForSelector('#msg-9900011000');
        await page.setViewport({ width: 1440, height: 960 });
        await shot('reading-desktop.png');
        const inset = await page.evaluate(
            () =>
                globalThis.document.querySelector('.msg-item').getBoundingClientRect().left -
                globalThis.document.querySelector('.content').getBoundingClientRect().left
        );
        assert.ok(inset <= 32, `正文左侧留白 ${inset}px`);
        await page.setViewport({ width: 360, height: 900 });
        assert.equal(
            await page.evaluate(
                () => globalThis.document.body.scrollWidth <= globalThis.innerWidth
            ),
            true
        );
        await shot('reading-mobile.png');
        assert.match(
            await page.$eval('#archiveFreshness', (element) => element.textContent),
            /实时同步已关闭/
        );
        assert.deepEqual(errors, []);
        record('切群提示隔离、正文左对齐、窄屏布局与同步状态');
        await page.setViewport({ width: 1280, height: 900 });
        await page.$eval('#messages', (element) => {
            element.scrollTop = 100;
        });
        extraMessages['2026-09-21'] = [
            newMessage('2026-09-21', 1),
            newMessage('2026-09-21', 2),
            newMessage('2026-09-21', 3),
        ];
        await page.evaluate(async (group) => {
            globalThis.startLive();
            globalThis.__archiveEventSource.onopen();
            await globalThis.__archiveEventSource.onmessage({
                data: JSON.stringify({ type: 'messages', group, dates: ['2026-09-21'] }),
            });
        }, groups[0].key);
        await page.waitForFunction(
            () => globalThis.document.querySelector('#messages').scrollTop === 100
        );
        assert.match(
            await page.$eval('#newArchiveBtn', (element) => element.textContent),
            /新增 3 条/
        );
        assert.match(
            await page.$eval('#archiveFreshness', (element) => element.textContent),
            /实时同步已连接/
        );
        extraMessages['2026-09-25'] = [newMessage('2026-09-25', 1)];
        await page.evaluate(async (group) => {
            await globalThis.__archiveEventSource.onmessage({
                data: JSON.stringify({ type: 'messages', group, dates: ['2026-09-25'] }),
            });
        }, groups[0].key);
        assert.match(await page.$eval('#readingDate', (element) => element.textContent), /21/);
        assert.equal(await page.$eval('#messages', (element) => element.scrollTop), 100);
        assert.match(
            await page.$eval('#newArchiveBtn', (element) => element.textContent),
            /新增 4 条/
        );
        await page.evaluate(() => globalThis.__archiveEventSource.onerror());
        assert.match(
            await page.$eval('#archiveFreshness', (element) => element.textContent),
            /连接中断/
        );
        await page.evaluate(() => globalThis.stopLive());
        record('合成实时事件：同日/跨日保持位置，连接与断开状态准确');

        extraMessages['2026-09-21'].push(newMessage('2026-09-21', 4));
        await page.click('#syncBtn');
        await page.waitForFunction(() => !globalThis.document.querySelector('#syncBtn').disabled);
        await page.waitForSelector('[id="msg-new-2026-09-21-4"]');
        assert.equal(await page.$eval('#messages', (element) => element.scrollTop), 100);
        assert.match(await page.$eval('#readingDate', (element) => element.textContent), /21/);
        assert.match(
            await page.$eval('#newArchiveBtn', (element) => element.textContent),
            /新增 5 条/
        );
        await page.setViewport({ width: 360, height: 900 });
        assert.equal(
            await page.evaluate(
                () => globalThis.document.body.scrollWidth <= globalThis.innerWidth
            ),
            true
        );
        await page.click('#toast');
        await shot('reading-mobile-new-messages.png');
        assert.deepEqual(errors, []);
        record('合成手动同步不移动日期与滚动位置，窄屏新增按钮无溢出');
        longHistory = true;
        archiveUpdates = false;
        await page.setViewport({ width: 1440, height: 960 });
        await page.reload({ waitUntil: 'networkidle0' });
        await page.waitForSelector('.msg-item');
        await page.click('#latestArchiveBtn');
        await page.waitForSelector('[id="msg-history-2026-09-26"]');
        assert.equal(await page.$$eval('.archive-day', (elements) => elements.length), 7);
        assert.equal(
            await page.$$eval(
                '[id^="archive-year-"][aria-expanded="false"]',
                (elements) => elements.length
            ),
            3
        );
        assert.match(
            await page.$eval('#archiveDateCount', (element) => element.textContent),
            /1000 天/
        );
        assert.match(
            await page.$eval('.archive-history-heading.older', (element) => element.textContent),
            /993 天/
        );
        await openDates();
        await shot('history-collapsed-desktop.png');
        await shot('tabs-date-drawer.png');
        await shot('graphite-production-date-drawer.png');
        await page.click('#archive-year-2026');
        assert.equal(await page.$$eval('.archive-day', (elements) => elements.length), 7);
        await page.click('#archive-month-2026-09');
        assert.match(
            await page.$eval('#archive-month-2026-09', (element) => element.textContent),
            /19 天/
        );
        assert.equal(
            await page.$$eval(
                '#archive-month-content-2026-09 .archive-day',
                (elements) => elements.length
            ),
            19
        );
        assert.equal(
            await page.$$eval(
                '.archive-day',
                (elements) =>
                    new Set(elements.map((element) => element.id)).size === elements.length
            ),
            true
        );
        await page.click('#archive-month-2026-09');
        assert.equal(await page.$$eval('.archive-day', (elements) => elements.length), 7);
        await page.focus('#archive-year-2026');
        await page.keyboard.press('Enter');
        assert.equal(
            await page.$eval('#archive-year-2026', (element) =>
                element.getAttribute('aria-expanded')
            ),
            'false'
        );
        record('1000 个跨年归档日默认仅 7 个日期按钮，年月折叠与天数准确，无重复日期');

        await search('闰日讨论');
        await page.waitForSelector('.sr-row');
        await page.click('.sr-row');
        await page.waitForSelector('[id="msg-history-2024-02-29"]');
        assert.equal(await visible('#archiveNav'), false);
        await openDates();
        assert.equal(
            await page.$eval('#archive-year-2024', (element) =>
                element.getAttribute('aria-expanded')
            ),
            'true'
        );
        assert.equal(
            await page.$eval('#archive-month-2024-02', (element) =>
                element.getAttribute('aria-expanded')
            ),
            'true'
        );
        assert.equal(
            await page.$$eval(
                '#archive-month-content-2024-02 .archive-day',
                (elements) => elements.length
            ),
            29
        );
        await page.waitForFunction(() => {
            const selected = globalThis.document
                .querySelector('#archive-date-2024-02-29')
                .getBoundingClientRect();
            const list = globalThis.document.querySelector('#archiveDates').getBoundingClientRect();
            return (
                selected.height > 0 && selected.top >= list.top && selected.bottom <= list.bottom
            );
        });
        await shot('history-old-date-desktop.png');
        await page.click('#archive-month-2024-02');
        const historyScroll = await page.$eval('#archiveDates', (element) => element.scrollTop);
        historyCounts['2024-02-28'] = 2;
        await page.evaluate(() => globalThis.loadDates());
        assert.equal(
            await page.$eval('#archive-month-2024-02', (element) =>
                element.getAttribute('aria-expanded')
            ),
            'false'
        );
        assert.equal(
            await page.$eval('#archiveDates', (element) => element.scrollTop),
            historyScroll
        );
        await page.click('#dateToggle');
        await page.click('.cal-day[aria-label="2024-02-28"]');
        await page.waitForSelector('[id="msg-history-2024-02-28"]');
        assert.equal(
            await page.$eval('#archive-date-2024-02-28', (element) =>
                element.getAttribute('aria-current')
            ),
            'date'
        );
        assert.equal(
            await page.$eval('#archive-month-2024-02', (element) =>
                element.getAttribute('aria-expanded')
            ),
            'true'
        );
        record('跨年搜索自动展开并定位，闰月 29 天，手动折叠刷新保持，日历跳转重新定位');
        await clickDateControl('#archive-month-2024-02');
        await clickDateControl('#dateToggle');
        await page.click('.cal-day[aria-label="2024-02-28"]');
        await page.waitForSelector('[id="msg-history-2024-02-28"]');
        assert.equal(
            await page.$eval('#archive-month-2024-02', (element) =>
                element.getAttribute('aria-expanded')
            ),
            'true'
        );
        record('从日历重新选择当前旧日期，也会展开已收起的月份');

        await page.setViewport({ width: 360, height: 900 });
        await page.click('#archiveNavToggle');
        await page.waitForFunction(() => {
            const selected = globalThis.document
                .querySelector('#archive-date-2024-02-28')
                .getBoundingClientRect();
            const list = globalThis.document.querySelector('#archiveDates').getBoundingClientRect();
            return (
                selected.height > 0 && selected.top >= list.top && selected.bottom <= list.bottom
            );
        });
        assert.equal(
            await page.evaluate(
                () => globalThis.document.body.scrollWidth <= globalThis.innerWidth
            ),
            true
        );
        await shot('history-mobile-navigation.png');
        await page.keyboard.press('Escape');
        await page.setViewport({ width: 1440, height: 960 });
        await chooseGroup('.archive-group:nth-child(2)');
        await page.waitForSelector('#msg-9900020000');
        assert.equal(await page.$$eval('.archive-period-toggle', (elements) => elements.length), 0);
        assert.equal(await page.$$eval('.archive-day', (elements) => elements.length), 1);
        await chooseGroup('.archive-group:first-child');
        await page.waitForSelector('[id="msg-history-2024-02-28"]');
        assert.equal(
            await page.$eval('#archive-month-2024-02', (element) =>
                element.getAttribute('aria-expanded')
            ),
            'true'
        );
        await page.click('#latestArchiveBtn');
        await page.waitForSelector('[id="msg-history-2026-09-26"]');
        await clickDateControl('#archive-date-2026-09-20');
        await page.waitForSelector('[id="msg-history-2026-09-20"]');
        historyCounts['2026-09-27'] = 1;
        await page.evaluate(() => globalThis.loadDates());
        assert.equal(
            await page.$$eval('.archive-recent .archive-day', (elements) => elements.length),
            7
        );
        assert.equal(
            await page.$eval('#archive-month-2026-09', (element) =>
                element.getAttribute('aria-expanded')
            ),
            'true'
        );
        assert.equal(
            await page.$$eval('#archive-date-2026-09-20', (elements) => elements.length),
            1
        );
        assert.match(await page.$eval('#readingDate', (element) => element.textContent), /20/);
        assert.deepEqual(errors, []);
        record('360px 旧日期可见、切群重置折叠、最近第七天移入历史后自动展开且不切日期');
        for (const date of Object.keys(historyCounts)) delete historyCounts[date];
        for (const date of [
            '2020-01-01',
            '2021-02-03',
            '2022-03-05',
            '2023-04-07',
            '2024-05-09',
            '2025-06-11',
            '2026-07-13',
        ])
            historyCounts[date] = 1;
        await page.reload({ waitUntil: 'networkidle0' });
        await page.waitForSelector('[id="msg-history-2026-07-13"]');
        assert.equal(await page.$$eval('.archive-day', (elements) => elements.length), 7);
        assert.equal(await page.$$eval('.archive-period-toggle', (elements) => elements.length), 0);
        assert.equal(
            await page.$$eval('#archive-date-2020-01-01', (elements) => elements.length),
            1
        );
        record('恰好 7 个稀疏归档日跨越 7 年，仍全部列为最近记录，不出现空的历史分组');
        for (const count of [1, 3, 30, 100]) {
            scaledGroups = Array.from({ length: count }, (_, index) => ({
                id: `group-${index + 1}`,
                name: `项目讨论群 ${String(index + 1).padStart(3, '0')}`,
            }));
            if (count >= 30) {
                scaledGroups[10].name = '同名讨论群';
                scaledGroups[11].name = '同名讨论群';
                scaledGroups[count - 1].name =
                    'AI 研发交流 & 产品讨论 <演示> · 跨团队知识分享与归档验证长群名';
            }
            await page.setViewport({ width: 1440, height: 960 });
            await page.reload({ waitUntil: 'networkidle0' });
            await page.waitForSelector('.msg-item');
            await chooseGroup('.archive-group:first-child');
            await page.waitForSelector('#msg-scaled-group-1');
            assert.equal(await visible('#groupPickerOverlay'), false);
            assert.equal(
                await page.$$eval('.group-picker-trigger', (elements) => elements.length),
                1
            );
            await page.click('#groupPickerToggle');
            assert.equal(
                await page.evaluate(() => globalThis.document.activeElement.id),
                'groupPickerSearch'
            );
            assert.equal(await page.$$eval('.archive-group', (elements) => elements.length), count);
            assert.match(
                await page.$eval('#groupPickerCount', (element) => element.textContent),
                new RegExp(`共 ${count} 个群`)
            );
            assert.equal(
                await page.$$eval(
                    '.archive-group[aria-current="page"]',
                    (elements) => elements.length
                ),
                1
            );
            if (count === 100) {
                await shot('selector-100-desktop.png');
                await shot('graphite-production-group-picker.png');
            }
            await page.type('#groupPickerSearch', '不存在的群名');
            assert.equal(await page.$$eval('.archive-group', (elements) => elements.length), 0);
            assert.match(
                await page.$eval('#archiveGroups', (element) => element.textContent),
                /没有匹配/
            );
            await page.keyboard.press('Enter');
            assert.equal(await visible('#groupPickerOverlay'), true);
            await page.keyboard.press('Escape');
            assert.equal(
                await page.evaluate(() => globalThis.document.activeElement.id),
                'groupPickerToggle'
            );
            await page.click('#groupPickerToggle');
            assert.equal(await page.$eval('#groupPickerSearch', (element) => element.value), '');
            const target = count >= 30 ? 'ai 研发' : String(count).padStart(3, '0');
            await page.type('#groupPickerSearch', target);
            assert.equal(await page.$$eval('.archive-group', (elements) => elements.length), 1);
            await page.$eval('#groupPickerSearch', (element) =>
                element.dispatchEvent(
                    new globalThis.KeyboardEvent('keydown', {
                        key: 'Enter',
                        isComposing: true,
                        bubbles: true,
                    })
                )
            );
            assert.equal(await visible('#groupPickerOverlay'), true);
            if (count === 100) await shot('selector-search-desktop.png');
            await page.keyboard.press('ArrowDown');
            assert.equal(
                await page.evaluate(() =>
                    globalThis.document.activeElement.classList.contains('archive-group')
                ),
                true
            );
            await page.keyboard.press('Enter');
            await page.waitForSelector(`#msg-scaled-group-${count}`);
            assert.equal(await visible('#groupPickerOverlay'), false);
            assert.equal(
                await page.$eval('#groupPickerLabel', (element) => element.textContent),
                scaledGroups[count - 1].name
            );
            if (count >= 30) {
                await page.click('#groupPickerToggle');
                await page.type('#groupPickerSearch', '同名');
                assert.equal(await page.$$eval('.archive-group', (elements) => elements.length), 2);
                await page.click('.archive-group:nth-child(2)');
                await page.waitForSelector('#msg-scaled-group-12');
                assert.equal(
                    await page.$eval('#groupPickerLabel', (element) => element.textContent),
                    '同名讨论群'
                );
            }
            await page.setViewport({ width: 360, height: 900 });
            await page.click('#groupPickerToggle');
            assert.equal(
                await page.evaluate(
                    () => globalThis.document.body.scrollWidth <= globalThis.innerWidth
                ),
                true
            );
            assert.equal(
                await page.$eval(
                    '#groupPickerDialog',
                    (element) => element.scrollWidth <= element.clientWidth
                ),
                true
            );
            if (count === 100) await shot('selector-100-mobile.png');
            if (count === 100) {
                await page.type('#groupPickerSearch', 'AI');
                await page.setViewport({ width: 360, height: 480 });
                assert.equal(
                    await page.$eval(
                        '#groupPickerDialog',
                        (element) =>
                            element.getBoundingClientRect().bottom <= globalThis.innerHeight
                    ),
                    true
                );
                assert.equal(
                    await page.$eval(
                        '#groupPickerDialog',
                        (element) => element.scrollWidth <= element.clientWidth
                    ),
                    true
                );
                await shot('selector-search-mobile.png');
                await page.click('#groupPickerSearch', { clickCount: 3 });
                await page.keyboard.press('Backspace');
                await page.setViewport({ width: 360, height: 900 });
            }
            await page.keyboard.down('Shift');
            await page.keyboard.press('Tab');
            await page.keyboard.up('Shift');
            assert.equal(
                await page.evaluate(() => globalThis.document.activeElement.id),
                'groupPickerClose'
            );
            await page.keyboard.down('Shift');
            await page.keyboard.press('Tab');
            await page.keyboard.up('Shift');
            assert.equal(
                await page.evaluate(
                    () => globalThis.document.activeElement.closest('#groupPickerDialog') !== null
                ),
                true
            );
            await page.click('#groupPickerClose');
            assert.equal(
                await page.$eval('.workspace', (element) => element.hasAttribute('inert')),
                false
            );
            await page.click('#groupPickerToggle');
            await page.click('#groupPickerOverlay', { offset: { x: 2, y: 2 } });
            assert.equal(await visible('#groupPickerOverlay'), false);
            assert.deepEqual(errors, []);
            record(`${count} 个群：统一入口、搜索/无结果、键盘选择与关闭、360px 无溢出`);
        }
        scaledGroups = null;
        longHistory = false;
        compactFixture = true;
        await page.setViewport({ width: 1280, height: 900 });
        await page.reload({ waitUntil: 'networkidle0' });
        await page.waitForSelector('#msg-compact-0');
        assert.deepEqual(
            await page.$$eval('.msg-item', (elements) => elements.map((element) => element.id)),
            compactMessages.map((message) => `msg-${message.id}`)
        );
        assert.equal(await page.$$eval('.msg-item-continuation', (elements) => elements.length), 3);
        assert.equal(
            await page.$eval('#msg-compact-9', (element) =>
                element.classList.contains('msg-item-continuation')
            ),
            false
        );
        assert.equal(
            await page.$$eval('#msg-compact-1 .msg-avatar', (elements) => elements.length),
            0
        );
        await page.waitForFunction(() => {
            const image = globalThis.document.querySelector('#msg-compact-0 .msg-avatar img');
            return image?.complete && image.naturalWidth === 128;
        });
        assert.equal(
            await page.$eval('#msg-compact-8 .msg-avatar', (element) => element.textContent),
            '同'
        );
        const rowHeight = await page.$eval(
            '#msg-compact-0',
            (element) => element.getBoundingClientRect().height
        );
        const continuationHeight = await page.$eval(
            '#msg-compact-1',
            (element) => element.getBoundingClientRect().height
        );
        assert.ok(
            rowHeight < 65 && continuationHeight < 35,
            `组首 ${rowHeight}px，续条 ${continuationHeight}px`
        );
        assert.equal(
            await page.$eval('#msg-compact-0 .msg-time', (element) => element.textContent),
            '09:00'
        );
        assert.equal(
            await page.$eval('#msg-compact-0 .msg-time', (element) => element.title),
            '2026/09/26 09:00:23'
        );
        assert.equal(await page.$$eval('.pause-divider', (elements) => elements.length), 1);
        await shot('compact-desktop.png');
        await shot('graphite-production-messages-desktop.png');
        const quote = '#msg-compact-5 .forward-quote';
        assert.equal(await page.$eval(quote, (element) => element.open), false);
        assert.match(
            await page.$eval(`${quote} summary`, (element) => element.textContent),
            /阿渡/
        );
        await page.click(`${quote} summary`);
        assert.match(
            await page.$eval(`${quote} .quote-full`, (element) => element.textContent),
            /本地归档/
        );
        await page.click(`${quote} .quote-jump`);
        await page.waitForSelector('#msg-compact-4.msg-flash');
        await page.click(`${quote} summary`);
        await page.click('#msg-compact-6 .msg-pics img');
        await page.waitForSelector('#lightbox.active');
        await page.keyboard.press('Escape');
        assert.equal(
            await page.$eval(
                '#msg-compact-6 img',
                (element) => element.complete && element.naturalWidth > 0
            ),
            true
        );
        record(
            `五类消息：原序与 ID 不变，同人连续分组、同名不同 ID 不合并、组首 ${Math.round(rowHeight)}px/续条 ${Math.round(continuationHeight)}px、长引用展开定位及图片预览`
        );
        await page.setViewport({ width: 360, height: 900 });
        await page.$eval('#messages', (element) => {
            element.scrollTop = 0;
        });
        assert.equal(await visible('#msg-compact-0 .msg-ctx-btn'), false);
        assert.ok(
            (await page.$eval(
                '#msg-compact-1',
                (element) => element.getBoundingClientRect().height
            )) < 60
        );
        assert.equal(
            await page.evaluate(
                () => globalThis.document.body.scrollWidth <= globalThis.innerWidth
            ),
            true
        );
        await shot('compact-mobile.png');
        await shot('graphite-production-messages-mobile.png');
        assert.equal(
            await page.$eval(
                '#msg-compact-1 .msg-menu summary',
                (element) => element.scrollWidth <= element.clientWidth
            ),
            true
        );
        await page.click('#msg-compact-1 .msg-menu summary');
        assert.match(
            await page.$eval('#msg-compact-1 .msg-menu-body', (element) => element.textContent),
            /09:01:23/
        );
        await shot('compact-mobile-menu.png');
        await shot('graphite-production-message-menu.png');
        await page.keyboard.press('Escape');
        assert.equal(
            await page.$eval('#msg-compact-1 .msg-menu', (element) => element.open),
            false
        );
        await page.click('#msg-compact-1 .msg-menu summary');
        await page.click('#msg-compact-1 .msg-menu button');
        await page.waitForSelector('#contextPanel.open');
        assert.equal(await page.$$eval('.msg-menu[open]', (elements) => elements.length), 0);
        await page.keyboard.press('Escape');
        await page.click('#msg-compact-6 .msg-menu summary');
        await page.keyboard.press('Escape');
        await page.$eval('#msg-compact-10', (element) => element.scrollIntoView({ block: 'end' }));
        await page.click('#msg-compact-10 .msg-menu summary');
        await page.evaluate(
            () => new Promise((resolve) => globalThis.requestAnimationFrame(resolve))
        );
        const bottomMenuFits = await page.evaluate(() => {
            const menu = globalThis.document
                .querySelector('#msg-compact-10 .msg-menu-body')
                .getBoundingClientRect();
            const viewport = globalThis.document.querySelector('#messages').getBoundingClientRect();
            return menu.top >= viewport.top && menu.bottom <= viewport.bottom;
        });
        assert.equal(bottomMenuFits, true, '底部消息菜单必须完整位于消息区内');
        await shot('compact-mobile-bottom-menu.png');
        await page.keyboard.press('Escape');
        await page.$eval('#msg-compact-6', (element) => element.scrollIntoView({ block: 'start' }));
        await shot('compact-mobile-attachments.png');
        assert.equal(
            await page.evaluate(
                () => globalThis.document.body.scrollWidth <= globalThis.innerWidth
            ),
            true
        );
        assert.deepEqual(errors, []);
        record('360px 紧凑续条、长链接和图片不溢出，消息菜单显示完整时间、Escape 关闭、上下文定位');
        await page.$eval('#msg-compact-0 .msg-avatar img', (image) => {
            image.src = 'https://example.invalid/avatars/broken.jpg';
        });
        await page.waitForFunction(
            () => !globalThis.document.querySelector('#msg-compact-0 .msg-avatar img')
        );
        assert.equal(
            await page.$eval('#msg-compact-0 .msg-avatar', (element) => element.textContent),
            '林'
        );
        record('连续发言只在组首显示图像；缺 avatar 或图片 404 时首字回退，不出现破图');
        await page.setViewport({ width: 1280, height: 900 });
        await page.reload({ waitUntil: 'networkidle0' });
        await page.waitForSelector('#msg-compact-0');
        const normalTitle = await page.title();
        const normalIcon = await page.$eval('link[rel="icon"]', (element) =>
            element.getAttribute('href')
        );
        const pressCodeShortcut = async () => {
            await page.keyboard.down('Alt');
            await page.keyboard.down('Shift');
            await page.keyboard.press('KeyX');
            await page.keyboard.up('Shift');
            await page.keyboard.up('Alt');
        };
        await page.click('#composeToggle');
        await page.type('#composerInput', '切换模式后仍然保留的草稿');
        await page.$eval('#messages', (element) => {
            element.scrollTop = 100;
        });
        const retainedPosition = await page.$eval('#messages', (element) => element.scrollTop);
        await page.$eval('#composerInput', (element) => {
            element.focus();
            element.setSelectionRange(2, 5);
        });
        await pressCodeShortcut();
        assert.equal(await visible('#codeModeView'), true);
        assert.equal(await visible('.workspace'), false);
        assert.equal(await visible('#composer'), false);
        assert.equal(await page.title(), 'workspace.log — Editor');
        assert.notEqual(
            await page.$eval('link[rel="icon"]', (element) => element.getAttribute('href')),
            normalIcon
        );
        assert.equal(
            await page.$$eval('#codeLog .code-row', (elements) => elements.length),
            compactMessages.length
        );
        assert.equal(await page.$$eval('#codeModeView img', (elements) => elements.length), 0);
        assert.doesNotMatch(
            await page.$eval('#codeModeView', (element) => element.innerText),
            /林青禾|半夏|阿渡|开源茶馆|小林/
        );
        assert.match(
            await page.$eval('#codeLog', (element) => element.innerText),
            /logger.info.*source_01/
        );
        assert.match(
            await page.$eval('#codeLog', (element) => element.innerText),
            /短消息可以更紧凑/
        );
        assert.match(
            await page.$eval('#codeLog', (element) => element.innerText),
            /attachments: 1/
        );
        await shot('code-mode-desktop.png');
        await page.keyboard.press('Escape');
        assert.equal(await visible('#codeModeView'), true);
        const notificationCount = await page.evaluate(() => globalThis.__notificationCalls.length);
        const sendCount = sends;
        await page.evaluate(async () => {
            globalThis.showToast('应被屏蔽的提示', 'error');
            const notes = [
                { title: '应被屏蔽的通知', body: '私密群聊', date: '2026-09-26', id: 'compact-0' },
            ];
            globalThis.showNotifications(notes, '私密群');
            globalThis.showDigestNotifications(notes, '私密群');
            await globalThis.sendChatMessage();
            await globalThis.sendChatImage({});
            globalThis.renderArchiveNavigation();
        });
        assert.equal(
            await page.evaluate(() => globalThis.__notificationCalls.length),
            notificationCount
        );
        assert.equal(sends, sendCount);
        assert.equal(await page.evaluate(() => globalThis.ensureNotifyPermission()), false);
        assert.equal(await visible('#toast'), false);
        assert.equal(await page.title(), 'workspace.log — Editor');
        await page.evaluate(() =>
            globalThis.document.dispatchEvent(
                new globalThis.KeyboardEvent('keydown', {
                    code: 'KeyX',
                    altKey: true,
                    shiftKey: true,
                    repeat: true,
                    bubbles: true,
                })
            )
        );
        assert.equal(await visible('#codeModeView'), true);
        await page.$eval('#codeLog', (element) => {
            element.scrollTop = 180;
        });
        await pressCodeShortcut();
        assert.equal(await page.title(), normalTitle);
        assert.equal(
            await page.$eval('link[rel="icon"]', (element) => element.getAttribute('href')),
            normalIcon
        );
        assert.equal(
            await page.$eval('#composerInput', (element) => element.value),
            '切换模式后仍然保留的草稿'
        );
        assert.deepEqual(
            await page.$eval('#composerInput', (element) => [
                element.selectionStart,
                element.selectionEnd,
            ]),
            [2, 5]
        );
        assert.equal(
            await page.$eval('#messages', (element) => element.scrollTop),
            retainedPosition
        );
        assert.equal(
            await page.evaluate(() => globalThis.document.activeElement.id),
            'composerInput'
        );
        await page.evaluate(() =>
            globalThis.document.dispatchEvent(
                new globalThis.KeyboardEvent('keydown', {
                    code: 'KeyX',
                    altKey: true,
                    shiftKey: true,
                    isComposing: true,
                    bubbles: true,
                })
            )
        );
        assert.equal(await visible('#codeModeView'), false);
        record(
            '代码模式：快捷键从输入框切换、匿名编号与纯文本、标题/favicon、通知/发送抑制、Escape 不暴露、草稿/选择区/阅读位置恢复'
        );

        await page.click('#codeModeToggle');
        const logPosition = await page.$eval('#codeLog', (element) => {
            element.scrollTop = 80;
            return element.scrollTop;
        });
        compactMessages.push({
            ...compactMessages[0],
            id: 'mode-incoming',
            content:
                '<img src=x onerror="globalThis.__codeExecuted=true"> @某人 group content </span><script>bad()</script>',
            time: '2026/09/26 10:01:00',
        });
        await page.evaluate(async () => {
            await globalThis.loadDates();
            await globalThis.loadMessages(true);
        });
        assert.equal(await page.$eval('#codeLog', (element) => element.scrollTop), logPosition);
        assert.equal(
            await page.$$eval('#codeLog .code-row', (elements) => elements.length),
            compactMessages.length
        );
        assert.equal(
            await page.$$eval('#codeLog img, #codeLog script', (elements) => elements.length),
            0
        );
        assert.equal(await page.evaluate(() => globalThis.__codeExecuted), undefined);
        assert.match(
            await page.$eval('#codeLog', (element) => element.innerText),
            /<img src=x onerror/
        );
        assert.equal(await page.title(), 'workspace.log — Editor');
        for (const width of [900, 390, 360]) {
            await page.setViewport({ width, height: 900 });
            assert.equal(
                await page.evaluate(
                    () => globalThis.document.body.scrollWidth <= globalThis.innerWidth
                ),
                true
            );
            assert.equal(
                await page.$eval(
                    '#codeLog',
                    (element) => element.scrollWidth <= element.clientWidth
                ),
                true
            );
        }
        await page.$eval('#codeLog', (element) => {
            element.scrollTop = 0;
        });
        await shot('code-mode-mobile.png');
        await page.click('#codeModeExit');
        assert.equal(
            await page.$eval('#messages', (element) => element.scrollTop),
            retainedPosition
        );
        await page.setViewport({ width: 1280, height: 900 });
        await page.$eval('#messages', (element) => {
            element.scrollTop = 100;
        });
        await page.click('#codeModeToggle');
        await page.evaluate(async () => {
            const originalFrame = globalThis.requestAnimationFrame;
            const pending = [];
            globalThis.requestAnimationFrame = (callback) => {
                pending.push(callback);
                return pending.length;
            };
            try {
                await globalThis.loadMessages(true);
                globalThis.toggleCodeMode();
                pending.forEach((callback) => callback());
            } finally {
                globalThis.requestAnimationFrame = originalFrame;
            }
        });
        assert.equal(
            await page.$eval('#messages', (element) => element.scrollTop),
            100,
            '退出模式后的延迟刷新不得覆盖阅读位置'
        );
        record('代码模式退出与后台延迟滚动任务交错时，普通阅读位置不被覆盖');
        await page.click('#settingsBtn');
        await pressCodeShortcut();
        assert.equal(await visible('#settingsModal'), false);
        await page.evaluate(() => globalThis.showToast('晚到提示', 'error'));
        await pressCodeShortcut();
        assert.equal(await visible('#settingsModal'), true);
        assert.equal(
            await page.$eval('#toast', (element) => element.classList.contains('show')),
            false
        );
        for (const theme of ['', 'qq2000', 'qq2008', 'qq2012', 'archive']) {
            await page.select('#themeSelect', theme);
            await pressCodeShortcut();
            assert.equal(await visible('#codeModeView'), true);
            assert.equal(
                await page.$eval(
                    '#codeModeView',
                    (element) => globalThis.getComputedStyle(element).backgroundColor
                ),
                'rgb(30, 34, 41)'
            );
            await pressCodeShortcut();
            assert.equal(await page.$eval('html', (element) => element.dataset.theme || ''), theme);
        }
        await page.keyboard.press('Escape');
        await page.click('#groupPickerToggle');
        await pressCodeShortcut();
        assert.equal(await visible('#groupPickerOverlay'), false);
        await pressCodeShortcut();
        assert.equal(await visible('#groupPickerOverlay'), true);
        await page.keyboard.press('Escape');
        await page.$eval('#messages', (element) => {
            element.scrollTop = 0;
        });
        await page.hover('#msg-compact-0');
        await page.locator('#msg-compact-0 .msg-ctx-btn').click();
        assert.equal(await visible('#researchPanel'), true, '切换前上下文面板应打开');
        const panelState = await page.$eval('#researchPanel', (element) => element.className);
        await pressCodeShortcut();
        assert.equal(await visible('#researchPanel'), false);
        assert.equal(
            await page.$eval('#researchPanel', (element) => element.className),
            panelState,
            '代码模式不移除面板状态'
        );
        await pressCodeShortcut();
        assert.equal(await visible('#researchPanel'), true);
        await page.keyboard.press('Escape');
        await page.click('#codeModeToggle');
        await page.reload({ waitUntil: 'networkidle0' });
        assert.equal(await visible('#codeModeView'), false);
        assert.equal(await page.evaluate(() => globalThis.Notification.permission), 'granted');
        await page.evaluate(() =>
            globalThis.showNotifications([{ title: '普通模式通知', body: '已恢复' }], 'group')
        );
        assert.equal(await page.evaluate(() => globalThis.__notificationCalls.length), 1);
        assert.deepEqual(errors, []);
        record(
            '代码模式：后台更新不暴露标题或执行 HTML、窄屏无溢出、弹窗和主题恢复、刷新默认关闭且普通通知恢复'
        );
        compactFixture = false;
        positionFixture = true;
        await page.setViewport({ width: 1280, height: 700 });
        await page.reload({ waitUntil: 'networkidle0' });
        await page.waitForSelector('[id="msg-resume-0-2026-09-26-0"]');
        const readStored = (group) =>
            page.evaluate(
                (group) =>
                    JSON.parse(
                        globalThis.localStorage.getItem(
                            'viewer-reading-v1:' + encodeURIComponent(group)
                        ) || 'null'
                    ),
                group
            );
        const placeAnchor = async (id, offset = 7) => {
            await page.$eval(
                '#messages',
                (container, { id, offset }) => {
                    const row = globalThis.document.getElementById('msg-' + id);
                    container.scrollTop +=
                        row.getBoundingClientRect().top -
                        container.getBoundingClientRect().top +
                        offset;
                    const top = container.getBoundingClientRect().top;
                    const cover = [...container.querySelectorAll('.time-divider')].reduce(
                        (height, divider) => {
                            const bounds = divider.getBoundingClientRect();
                            return bounds.top <=
                                top +
                                    (parseFloat(globalThis.getComputedStyle(divider).marginTop) ||
                                        0) +
                                    1
                                ? Math.max(height, bounds.bottom - top)
                                : height;
                        },
                        0
                    );
                    container.scrollTop -= cover;
                },
                { id, offset }
            );
            await page.waitForFunction(
                ({ id, offset }) => {
                    const row = globalThis.document.getElementById('msg-' + id);
                    return (
                        Math.abs(
                            globalThis.readingViewportTop(
                                globalThis.document.querySelector('#messages')
                            ) -
                                row.getBoundingClientRect().top -
                                offset
                        ) < 1
                    );
                },
                {},
                { id, offset }
            );
        };
        const assertAnchor = async (id, offset = 7) => {
            await page.waitForSelector(`[id="msg-${id}"]`);
            const displacement = await page.$eval(
                '#messages',
                (container, id) =>
                    globalThis.readingViewportTop(container) -
                    globalThis.document.getElementById('msg-' + id).getBoundingClientRect().top,
                id
            );
            assert.ok(
                Math.abs(displacement - offset) < 1,
                `消息 ${id} 偏移 ${displacement}, 预期 ${offset}`
            );
        };
        await clickDateControl('#archive-date-2026-08-10');
        await page.waitForSelector('[id="msg-resume-0-2026-08-10-0"]');
        const groupAAnchor = 'resume-0-2026-08-10-18';
        await placeAnchor(groupAAnchor);
        const oldPixels = await page.$eval('#messages', (element) => element.scrollTop);
        await chooseGroup('.archive-group:nth-child(2)');
        await page.waitForSelector('[id="msg-resume-1-2026-09-26-0"]');
        assert.equal((await readStored(groups[0].key)).messageId, groupAAnchor);
        const groupBAnchor = 'resume-1-2026-09-26-12';
        await placeAnchor(groupBAnchor, 9);
        const storedDate = positionData.get(groups[0].key)['2026-08-10'];
        storedDate.unshift(
            ...Array.from({ length: 5 }, (_, index) => ({
                ...storedDate[0],
                id: `inserted-${index}`,
                content: `后来补录的更早消息 ${index}`,
            }))
        );
        await chooseGroup('.archive-group:first-child');
        await assertAnchor(groupAAnchor);
        assert.equal(
            await page.evaluate((id) => {
                const message = globalThis.document.getElementById('msg-' + id);
                const divider = globalThis.document.querySelector('#messages .time-divider');
                return (
                    message.querySelector('.msg-content').getBoundingClientRect().top >=
                    divider.getBoundingClientRect().bottom
                );
            }, groupAAnchor),
            true,
            '恢复目标正文不能被固定分隔条遮挡'
        );
        assert.ok((await page.$eval('#messages', (element) => element.scrollTop)) > oldPixels);
        assert.match(
            await page.$eval('#readingDate', (element) => element.textContent),
            /08 \/ 10/
        );
        await shot('reading-position-restored.png');
        await chooseGroup('.archive-group:nth-child(2)');
        await assertAnchor(groupBAnchor, 9);
        await page.reload({ waitUntil: 'networkidle0' });
        await assertAnchor(groupBAnchor, 9);
        assert.equal(
            await page.$eval('#archiveTitle', (element) => element.textContent),
            groups[1].name
        );
        const saved = await readStored(groups[0].key);
        assert.deepEqual(Object.keys(saved).sort(), [
            'date',
            'messageId',
            'offset',
            'version',
            'view',
        ]);
        record(
            '每群阅读记忆：跨日切群、最后访问群刷新恢复；前插 5 条后仍定位原消息，行内偏移误差 <1px，仅存元数据'
        );

        await page.click('#codeModeToggle');
        const codeAnchor = 'resume-1-2026-09-26-16';
        await page.$eval(
            '#codeLog',
            (container, id) => {
                const row = [...container.querySelectorAll('.code-row')].find(
                    (row) => row.dataset.messageId === id
                );
                container.scrollTop +=
                    row.getBoundingClientRect().top - container.getBoundingClientRect().top;
            },
            codeAnchor
        );
        await page.waitForFunction(
            (group) =>
                JSON.parse(
                    globalThis.localStorage.getItem(
                        'viewer-reading-v1:' + encodeURIComponent(group)
                    ) || 'null'
                )?.messageId === 'resume-1-2026-09-26-16',
            {},
            groups[1].key
        );
        await page.reload({ waitUntil: 'networkidle0' });
        await assertAnchor(codeAnchor, 0);
        assert.equal(await visible('#codeModeView'), false);
        await page.click('#latestArchiveBtn');
        await page.waitForFunction(() => {
            const list = globalThis.document.querySelector('#messages');
            return list.scrollHeight - list.scrollTop - list.clientHeight < 2;
        });
        await clickDateControl('#archive-date-2026-08-10');
        await page.waitForSelector('[id="msg-resume-1-2026-08-10-0"]');
        assert.equal(await page.$eval('#messages', (element) => element.scrollTop), 0);
        await page.evaluate(() => globalThis.jumpToSource('2026-09-26', 'resume-1-2026-09-26-8'));
        await page.waitForSelector('[id="msg-resume-1-2026-09-26-8"].msg-flash');
        record('代码模式刷新按消息 ID 恢复普通阅读；最新归档、主动选日及来源跳转不被旧书签劫持');

        await chooseGroup('.archive-group:first-child');
        await assertAnchor(groupAAnchor);
        await chooseGroup('.archive-group:nth-child(2)');
        positionData.get(groups[0].key)['2026-08-10'] = storedDate.filter(
            (message) => message.id !== groupAAnchor
        );
        await chooseGroup('.archive-group:first-child');
        await page.waitForSelector('#msg-inserted-0');
        assert.equal(await page.$eval('#messages', (element) => element.scrollTop), 0);
        await chooseGroup('.archive-group:nth-child(2)');
        delete positionData.get(groups[0].key)['2026-08-10'];
        await chooseGroup('.archive-group:first-child');
        await page.waitForSelector('[id="msg-resume-0-2026-09-26-0"]');
        assert.equal(await page.$eval('#messages', (element) => element.scrollTop), 0);
        await page.evaluate(
            (group) =>
                globalThis.localStorage.setItem(
                    'viewer-reading-v1:' + encodeURIComponent(group),
                    '{broken json'
                ),
            groups[2].key
        );
        await chooseGroup('.archive-group:nth-child(3)');
        await page.waitForSelector('[id="msg-resume-2-2026-09-26-0"]');
        assert.equal(await page.$eval('#messages', (element) => element.scrollTop), 0);
        record('原消息删除回当天开头，原日期删除回最新归档，损坏存储安全降级');

        const stableAnchor = 'resume-2-2026-09-26-17';
        await placeAnchor(stableAnchor);
        holdPositionGroup = groups[0].key;
        const delayedPositionRequest = page.waitForRequest(
            (request) =>
                new URL(request.url()).pathname === '/api/messages' &&
                new URL(request.url()).searchParams.get('group') === groups[0].key
        );
        await chooseGroup('.archive-group:first-child');
        await delayedPositionRequest;
        assert.equal(typeof heldPositionReply, 'function');
        await chooseGroup('.archive-group:nth-child(3)');
        await assertAnchor(stableAnchor);
        await heldPositionReply();
        holdPositionGroup = '';
        await page.evaluate(
            () => new Promise((resolve) => globalThis.requestAnimationFrame(resolve))
        );
        await assertAnchor(stableAnchor);
        assert.notEqual((await readStored(groups[0].key)).messageId, stableAnchor);
        record('快速切群与延迟消息响应不串写书签，也不跳离当前消息');

        await page.evaluate(() => {
            globalThis.__originalStorageGet = globalThis.Storage.prototype.getItem;
            globalThis.__originalStorageSet = globalThis.Storage.prototype.setItem;
            globalThis.Storage.prototype.getItem = () => {
                throw new Error('storage unavailable');
            };
            globalThis.Storage.prototype.setItem = () => {
                throw new Error('storage unavailable');
            };
        });
        const memoryAnchor = 'resume-2-2026-09-26-22';
        await placeAnchor(memoryAnchor);
        await chooseGroup('.archive-group:nth-child(2)');
        await page.waitForSelector('[id="msg-resume-1-2026-09-26-0"]');
        await chooseGroup('.archive-group:nth-child(3)');
        await assertAnchor(memoryAnchor);
        await page.evaluate(() => {
            globalThis.Storage.prototype.getItem = globalThis.__originalStorageGet;
            globalThis.Storage.prototype.setItem = globalThis.__originalStorageSet;
        });
        await page.evaluate(() => {
            globalThis.Storage.prototype.setItem = () => {
                throw new Error('QuotaExceededError');
            };
        });
        const quotaAnchor = 'resume-2-2026-09-26-24';
        await placeAnchor(quotaAnchor);
        await chooseGroup('.archive-group:nth-child(2)');
        await page.waitForSelector('[id="msg-resume-1-2026-09-26-0"]');
        await chooseGroup('.archive-group:nth-child(3)');
        await assertAnchor(quotaAnchor);
        await page.evaluate(() => {
            globalThis.Storage.prototype.setItem = globalThis.__originalStorageSet;
        });
        await page.setViewport({ width: 360, height: 900 });
        await placeAnchor(quotaAnchor);
        await page.reload({ waitUntil: 'networkidle0' });
        await assertAnchor(quotaAnchor);
        assert.equal(
            await page.evaluate(
                () => globalThis.document.body.scrollWidth <= globalThis.innerWidth
            ),
            true
        );
        await shot('reading-position-mobile.png');
        record('仅写入失败时优先会话内新位置，360px 刷新恢复相同消息且无横向溢出');
        const blockedStorage = await page.evaluateOnNewDocument(() => {
            globalThis.Storage.prototype.getItem = () => {
                throw new Error('storage unavailable');
            };
            globalThis.Storage.prototype.setItem = () => {
                throw new Error('storage unavailable');
            };
        });
        await page.reload({ waitUntil: 'networkidle0' });
        await page.waitForSelector('[id="msg-resume-0-2026-09-26-0"]');
        assert.deepEqual(errors, []);
        await page.removeScriptToEvaluateOnNewDocument(blockedStorage.identifier);
        record('存储不可用时会话内恢复仍有效，刷新安全退回默认群，页面无异常');
        positionFixture = false;
        emptyArchive = true;
        await page.reload({ waitUntil: 'networkidle0' });
        await page.waitForSelector('#messages .empty');
        assert.equal(await page.$$eval('.archive-group', (elements) => elements.length), 0);
        assert.match(
            await page.$eval('#archiveDates', (element) => element.textContent),
            /暂无历史记录/
        );
        assert.equal(await page.$eval('#composeToggle', (element) => element.disabled), true);
        assert.deepEqual(errors, []);
        await shot('archive-empty.png');
        await page.click('#groupPickerToggle');
        assert.match(
            await page.$eval('#archiveGroups', (element) => element.textContent),
            /还没有归档/
        );
        await page.keyboard.press('Escape');
        await page.click('#codeModeToggle');
        assert.match(await page.$eval('#codeLog', (element) => element.textContent), /No records/);
        await page.click('#codeModeExit');
        assert.equal(await visible('#codeModeView'), false);
        record('无群聊、无日期的空档案引导');
        fs.writeFileSync(
            path.join(artifacts, 'archive-report.json'),
            JSON.stringify(
                {
                    passed,
                    errors,
                    sends,
                    fixtures: 'synthetic only',
                    ai: 'mocked responses, not a quality or latency benchmark',
                },
                null,
                2
            )
        );
        console.log(`PASS ${passed.length} groups of browser checks; artifacts: ${artifacts}`);
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
