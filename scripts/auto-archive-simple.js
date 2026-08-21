const puppeteer = require('puppeteer');
const fs = require('fs');
const path = require('path');
const https = require('https');
const { exec, spawn } = require('child_process');
const { resolveChromePath } = require('../lib/chrome-path');
const cookieStore = require('../lib/cookie-store');
const { formatLocalDate, formatLocalTime, writeJsonAtomic, mergeIntoDayFile } = require('../lib/day-file');
const weiboAuth = require('../lib/weibo-auth');
const { normalizeMessage } = require('../lib/normalize-message');
const { readUtf8 } = require('../lib/read-stream');
const syncLock = require('../lib/sync-lock');
const { paginateMessages } = require('../lib/paginate');
const { buildPageScript } = require('../lib/page-hook');

// 仓库根目录（本脚本在 scripts/ 下,运行时数据仍存根目录）
const ROOT = path.join(__dirname, '..');

// 配置
const CONFIG = {
    chatUrl: 'https://api.weibo.com/chat#/chat',
    outputDir: path.join(ROOT, 'output'),
    chromePath: resolveChromePath((() => { try { return require('../config.json').chromePath; } catch { return ''; } })()),
    launchDelay: 3000,
};

const configData = require('../config.json');
const GROUPS = configData.groups || [configData.groupName || '茧房建筑师协会'];

function getGroupOutputDir(groupName) {
    const safe = groupName.replace(/[^a-zA-Z0-9一-鿿]/g, '_');
    return path.join(CONFIG.outputDir, safe);
}

function getGroupStateFile(groupName) {
    const safe = groupName.replace(/[^a-zA-Z0-9一-鿿]/g, '_');
    const stateDir = path.join(ROOT, 'state');
    if (!fs.existsSync(stateDir)) fs.mkdirSync(stateDir, { recursive: true });
    return path.join(stateDir, `last-archive-state_${safe}.json`);
}
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

// headless 下没有窗口，"等待手动操作"之类的交互兜底一律跳过。
// 调试时 HEADLESS=0 npm run archive 可开出真实窗口。
const HEADLESS = process.env.HEADLESS !== '0';

// 单群失败的即时重试次数（1 = 最多再试一次）。网络抖动砸在切群瞬间时，
// 重试单群远比让整轮失败、30 秒后重跑全部群划算。
const GROUP_RETRIES = 1;
const GROUP_RETRY_DELAY_MS = 8000;

// 检测是否需要登录。判据见 lib/weibo-auth.js（接口 error_code，不猜 DOM）；
// 探测本身失败时才退回 URL/标题/文案启发式。
async function checkLoginRequired(page) {
    const authed = await weiboAuth.isAuthenticated(page);
    if (authed !== null) return !authed;

    // 启发式兜底：URL / 标题 / 页面文案
    return await page.evaluate(() => {
        if (location.href.includes('login') || location.href.includes('passport')) return true;
        const title = document.title || '';
        if (title.includes('登录') || title.includes('login')) return true;
        // api.weibo.com/chat 用失效 Cookie 打开时 URL/标题不变，但页面内显示扫码二维码
        const text = (document.body && document.body.innerText) || '';
        if (text.includes('扫描登录') || text.includes('扫码') ||
            text.includes('二维码') || text.includes('立即注册') ||
            text.includes('用微博手机版扫描')) {
            return true;
        }
        return false;
    });
}

// 等待扫码登录完成
async function waitForLogin(page) {
    if (HEADLESS) {
        // headless 没有窗口可供扫码，等下去只会浪费 5 分钟后仍然失败。
        console.error('');
        console.error('========================================');
        console.error('  微博 Cookie 已失效，需要重新扫码登录');
        console.error('  当前是 headless 模式，没有窗口可以扫码，本次归档中止。');
        console.error('  请运行:  npm run save-cookies');
        console.error('========================================');
        console.error('');
        return false;
    }

    console.log('');
    console.log('========================================');
    console.log('  需要登录微博');
    console.log('  请在弹出的浏览器窗口中扫码登录');
    console.log('  登录完成后脚本会自动继续');
    console.log('========================================');
    console.log('');

    if (!await weiboAuth.waitForAuth(page, { timeoutMs: 300000 })) {
        console.log('等待登录超时（5分钟）');
        return false;
    }

    console.log('检测到已登录！');
    await delay(3000);

    // 保存完整 Cookie（cookie-store 会校验 SUB，无登录态时拒绝写入）
    const cookies = cookieStore.filterWeiboCookies(await page.browser().cookies());
    if (cookieStore.saveCookies(cookies, '扫码登录').ok) return true;

    console.log('接口鉴权已通过但未取到 SUB Cookie');
    return false;
}

// 注入页面的 hook 脚本：实现在 lib/page-hook.js（normalizeMessage 与
// lib/normalize-message.js 同源，运行时序列化拼接，不再手抄内联副本）
const USER_SCRIPT = buildPageScript();

async function main() {
    console.log('=== 微博聊天自动归档 ===');
    console.log('启动时间:', new Date().toLocaleString('zh-CN'));

    if (!fs.existsSync(CONFIG.outputDir)) {
        fs.mkdirSync(CONFIG.outputDir, { recursive: true });
    }

    // 启动浏览器（使用保存的 Cookie 登录）
    console.log('启动浏览器...');
    const browser = await puppeteer.launch({
        headless: HEADLESS ? 'new' : false,
        executablePath: CONFIG.chromePath,
        defaultViewport: null,
        protocolTimeout: 600000,
        args: [
            '--no-sandbox',
            '--disable-setuid-sandbox',
            '--window-size=1280,800',
        ],
    });

    // newPage() 必须在 try 内：它抛错（protocol error / target crash）时
    // finally 不会执行，浏览器泄漏，而 runWithRetry 紧接着又 launch 一个。
    let page;
    // 被跳过的群 —— 归档器必须以非 0 退出码收场，否则 launchd/cron 看不出
    // 它已经连着好几天什么都没抓到（历史上就这么静默失效过 3 天）。
    const skippedGroups = [];
    try { // 确保任何异常都能关闭浏览器，防止僵尸 Chrome 进程
    page = await browser.newPage();

    // 监听浏览器控制台输出
    page.on('console', msg => {
        if (msg.type() === 'error') console.log('[浏览器错误]', msg.text());
    });
    page.on('pageerror', err => console.log('[页面错误]', err.message));

    // Puppeteer 网络层消息捕获
    let networkMessages = [];
    const capturedApiUrls = []; // 完整捕获消息 API URL

    page.on('response', async (response) => {
        const url = response.url();

        // 捕获完整的 query_messages API URL
        if (/query_messages\.json/.test(url)) {
            capturedApiUrls.push(url);
        }

        if (/\/webim\/.*message|query_messages|groupchat.*message/i.test(url)) {
            try {
                const data = await response.json();
                const msgs = data.messages || data.data?.messages || data.data || [];
                const msgList = Array.isArray(msgs) ? msgs : (Array.isArray(data.list) ? data.list : []);
                for (const m of msgList) {
                    const id = m?.id || m?.mid || m?.message_id || null;
                    if (id) {
                        // 直接产出与其它两条来源同构的记录（含 timestamp）：
                        // 缺 timestamp 会让下游 sort 得 NaN、按天分文件错位，
                        // 并可能把 state 的 lastTimestamp 推成 Date.now()。
                        const ts = typeof m.time === 'number' && m.time > 0 ? m.time * 1000 : Date.now();
                        networkMessages.push({
                            id,
                            from_uid: m.from_uid || m.from_user?.id || null,
                            user: m.from_user?.screen_name || m.from_user?.name || m.from_uid || '未知',
                            timestamp: ts,
                            time: formatLocalTime(ts),
                            date: formatLocalDate(ts),
                            content: (m.content ?? m.text ?? m.message ?? '').replace(/[\r\n]+/g, ' ').trim(),
                            type: m.type || m.msg_type || 'text',
                        });
                    }
                }
            } catch {}
        }
    });

    // 加载 Cookie（cookie-store 统一处理域名补点等规范化；
    // browser.setCookie 是 page.setCookie 的非弃用替代）
    let cookieLoaded = false;
    {
        const cookies = cookieStore.normalizeDomains(cookieStore.loadCookies());
        if (cookies.length > 0) {
            await browser.setCookie(...cookies);
            console.log(`已加载 ${cookies.length} 个 Cookie`);
            cookieLoaded = true;
        }
    }

    if (!cookieLoaded) {
        console.log('未找到 Cookie 文件，首次运行需要登录');
    }

    // 导航到聊天页面
    console.log('打开微博聊天页面...');
    await page.goto(CONFIG.chatUrl, {
        waitUntil: 'networkidle2',
        timeout: 60000,
    });

    await delay(CONFIG.launchDelay);

    let title = '';
    try {
        title = await page.title();
    } catch (e) {
        console.log('获取页面标题失败，继续执行...');
    }
    console.log('页面标题:', title);

    // 截图
    try {
        await page.screenshot({ path: path.join(ROOT, 'debug.png'), fullPage: false });
        console.log('截图已保存: debug.png');
    } catch (e) {
        console.log('截图失败，继续执行...');
    }

    // 检查是否需要登录
    let needLogin = false;
    try {
        needLogin = await checkLoginRequired(page);
    } catch (e) {
        console.log('检查登录状态失败，假设已登录...');
    }

    if (needLogin) {
        const loginOk = await waitForLogin(page);
        if (!loginOk) {
            // 抛出而非 process.exit：后者会跳过 finally 里的 browser.close()，
            // 留下僵尸 Chrome。标记 fatal 让 runWithRetry 不做无意义的重试。
            const e = new Error('Cookie 已失效，需要重新扫码登录（npm run save-cookies）');
            e.fatal = true;
            throw e;
        }

        // 登录成功后重新导航到聊天页
        await delay(2000);
        if (!page.url().includes('chat')) {
            console.log('导航到聊天页面...');
            await page.goto(CONFIG.chatUrl, {
                waitUntil: 'networkidle2',
                timeout: 60000,
            });
            await delay(CONFIG.launchDelay);
        }

        // 再截图确认
        await page.screenshot({ path: path.join(ROOT, 'debug.png'), fullPage: false });
        console.log('登录后截图已保存: debug.png');
    } else {
        console.log('登录状态正常');

        // 每次运行成功后也更新 Cookie（cookie-store 校验 SUB，失效会话不会覆盖）
        cookieStore.saveCookies(cookieStore.filterWeiboCookies(await browser.cookies()), '归档运行续期');
    }

    // 注入归档脚本（在点击群聊之前，这样可以捕获所有 API 响应）
    // 写入临时文件，使用 path 方式注入以避免字符串转义问题
    const scriptFile = path.join(ROOT, '.archiver-script.js');
    fs.writeFileSync(scriptFile, USER_SCRIPT);
    console.log('注入归档脚本...');
    await page.addScriptTag({ path: scriptFile });
    await delay(2000);
    const scriptOk = await page.evaluate(() => !!window.__ARCHIVER_STATE__).catch(() => false);
    if (!scriptOk) {
        console.log('⚠ 初始脚本注入失败，尝试重新注入...');
        await delay(3000);
        await page.addScriptTag({ path: scriptFile });
        await delay(2000);
    }
    const finalCheck = await page.evaluate(() => !!window.__ARCHIVER_STATE__).catch(() => false);
    console.log('归档脚本状态:', finalCheck ? '✓ 已就绪' : '✗ 未就绪');

    // 等待页面初始加载的 API 请求，获取第一个群的 group ID
    await delay(3000);
    let initialGroupId = await page.evaluate(() => window.__ARCHIVER_STATE__?.lastGroupId || null);
    console.log('初始群组 ID:', initialGroupId || '(未获取)');

    // 关闭可能存在的弹窗（如"扫码分享"等）
    await page.evaluate(() => {
        // 关闭模态弹窗
        document.querySelectorAll('[class*="modal"], [class*="dialog"], [class*="overlay"], [class*="popup"]').forEach(el => {
            if (el.offsetHeight > 0) {
                const closeBtn = el.querySelector('[class*="close"], [class*="dismiss"]');
                if (closeBtn) closeBtn.click();
            }
        });
        // 按 ESC 关闭弹窗
        document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', keyCode: 27, bubbles: true }));
    });
    await delay(500);

    console.log('目标群聊:', GROUPS.join(', '));

    // groupId -> 已归档的群名，用于检出"会话未切换"导致的串档
    const archivedGroupIds = new Map();
    for (const [groupIdx, currentGroupName] of GROUPS.entries()) {
    // 单群即时重试 + 单群失败隔离。
    // 网络抖动（net::ERR_NETWORK_CHANGED 之类）会让切群瞬间的页面请求整批失败：
    // 抓不到 group id → 整群被跳过；抖动后的残留异常还会把整轮打断，于是
    // runWithRetry 30 秒后重跑全部群。实测 2026-08-09 04:09 那轮就是这样，
    // 两个群一个被跳过、一个把整轮带崩。重试单群比重跑整轮便宜得多。
    let groupDone = false;
    for (let attempt = 0; attempt <= GROUP_RETRIES && !groupDone; attempt++) {
    try {
    if (attempt > 0) {
        console.log(`↻ 重试「${currentGroupName}」（第 ${attempt + 1}/${GROUP_RETRIES + 1} 次）`);
        await delay(GROUP_RETRY_DELAY_MS);
    }
    networkMessages = []; // 每个群独立，不累积上一个群的网络层消息
    const groupDir = getGroupOutputDir(currentGroupName);
    const stateFile = getGroupStateFile(currentGroupName);
    if (!fs.existsSync(groupDir)) fs.mkdirSync(groupDir, { recursive: true });

    // 自动点击群聊
    console.log(`\n--- 归档群聊: ${currentGroupName} ---`);
    console.log(`查找群聊: ${currentGroupName}...`);
    await delay(1000);

    // 点击前的快照：切群后的 group id 必须来自点击之后新产生的请求。
    // 否则点击没真正切换会话时会沿用上一个群的 id，把它的消息写进本群目录。
    const urlCountBeforeClick = capturedApiUrls.length;

    const groupClicked = await page.evaluate((groupName) => {
        // 方法1: 查找所有文本内容完全匹配的叶子元素
        const allElements = document.querySelectorAll('*');
        for (const el of allElements) {
            if (el.childElementCount === 0 || el.childElementCount === 1) {
                const text = (el.textContent || '').trim();
                if (text === groupName && el.offsetHeight > 0) {
                    // 向上找到可点击的容器
                    let target = el;
                    for (let i = 0; i < 5; i++) {
                        if (!target.parentElement) break;
                        target = target.parentElement;
                        if (target.tagName === 'LI' || target.tagName === 'A' ||
                            target.onclick || target.getAttribute('role') === 'listitem') {
                            target.click();
                            return { found: true, method: 'container' };
                        }
                    }
                    // 直接点击
                    el.click();
                    return { found: true, method: 'direct' };
                }
            }
        }

        // 方法2: 模糊匹配，查找包含群名的元素
        for (const el of allElements) {
            const text = (el.textContent || '').trim();
            if (text.includes(groupName) && text.length < groupName.length + 20 && el.offsetHeight > 0) {
                el.click();
                return { found: true, method: 'fuzzy' };
            }
        }

        return { found: false, method: 'none' };
    }, currentGroupName);

    if (groupClicked.found) {
        console.log(`✓ 已点击群聊 (方式: ${groupClicked.method})`);
        // 等待页面可能的导航和加载
        try { await page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 10000 }); } catch {}
        await delay(3000);
    } else if (HEADLESS) {
        // headless 下没有窗口可供人操作，等 60 秒纯属浪费；
        // 群 id 解析不到会在下面跳过此群。
        console.log(`⚠ 未找到群聊 "${currentGroupName}"（headless 无窗口，不等待手动操作）`);
    } else {
        console.log('⚠ 未找到群聊，请手动点击');
        console.log('等待 60 秒供手动操作...');
        await delay(60000);
    }

    // 检查 __ARCHIVER_STATE__ 是否存在，不存在则重新注入
    let scriptInjected = await page.evaluate(() => !!window.__ARCHIVER_STATE__).catch(() => false);
    if (!scriptInjected) {
        console.log('归档脚本不存在，等待页面稳定并重新注入...');
        await delay(3000);
        try {
            await page.addScriptTag({ path: scriptFile });
            await delay(2000);
            scriptInjected = await page.evaluate(() => !!window.__ARCHIVER_STATE__).catch(() => false);
        } catch (e) {
            console.log('脚本注入出错:', e.message);
        }
        if (!scriptInjected) {
            console.log('⚠ 脚本注入失败');
            if (attempt < GROUP_RETRIES) continue;   // 页面可能只是还没稳，再来一次
            skippedGroups.push(`${currentGroupName}(脚本注入失败)`);
            break;
        }
        console.log('✓ 脚本重新注入成功');
    }

    // 自动加载历史消息 — 通过 API 直接分页获取
    console.log('开始通过 API 分页加载所有历史消息...');

    await page.evaluate(() => {
        window.__ARCHIVER_STATE__?.reset();
    }).catch(() => {});

    console.log('等待 API 请求...');
    let groupId = null;

    // 从捕获的 URL 中向后搜索 group ID（取最新的一个）。
    // id=0 必须排除：页面加载时的探测请求就带 id=0，而它是字符串 "0" —— truthy，
    // 会一路当成有效会话 id 用下去，查询必然返回"群不存在"，于是 0 条消息、
    // 不落盘、退出码 0，整群静默空跑（实测踩过）。
    function findGroupIdFromUrls(startIdx) {
        for (let j = capturedApiUrls.length - 1; j >= (startIdx || 0); j--) {
            const match = capturedApiUrls[j].match(/[?&]id=(\d+)/);
            if (match && match[1] !== '0') return match[1];
        }
        return null;
    }

    // 优先取点击之后新产生的请求 —— 那才确定是当前群的会话
    groupId = findGroupIdFromUrls(urlCountBeforeClick);
    if (!groupId) {
        for (let i = 0; i < 20 && !groupId; i++) {
            await delay(1000);
            groupId = findGroupIdFromUrls(urlCountBeforeClick);
        }
    }
    if (groupId) {
        console.log(`✓ 从切群后的 API 请求获取群组 ID: ${groupId}`);
    } else if (groupIdx === 0 && groupClicked.found) {
        // 只有第一个群、且确实点到了它，才允许回退到页面加载时的请求：
        // 它本来就是默认打开的会话，点击可能不产生新请求。
        // 没点到就回退是危险的 —— 那等于把"默认打开的随便哪个会话"的消息
        // 记到这个群名下；第二个群往后回退同理（会沿用上一个群的 id）。
        groupId = findGroupIdFromUrls(0);
        if (groupId) console.log(`✓ 从页面加载时的 API 请求获取群组 ID: ${groupId}`);
    }

    if (!groupId) {
        console.log(`⚠ 无法获取群 "${currentGroupName}" 的 ID（切群后未捕获到 API 请求）`);
        if (attempt < GROUP_RETRIES) continue;   // 网络抖动最常砸在这里
        skippedGroups.push(`${currentGroupName}(未取到群 ID)`);
        break;
    }
    // 串档护栏：同一轮里两个群解析出同一个 id，说明会话没真正切换
    if (archivedGroupIds.has(groupId)) {
        console.log(`⚠ 群 "${currentGroupName}" 解析出的 ID ${groupId} 已被 "${archivedGroupIds.get(groupId)}" 占用，`
            + `说明会话未真正切换，跳过此群（避免把上一个群的消息写进本群目录）`);
        if (attempt < GROUP_RETRIES) continue;   // 再点一次，会话可能就切过去了
        skippedGroups.push(`${currentGroupName}(会话未切换)`);
        break;
    }

    // 等待初始消息加载
    let waitCount = 0;
    while (waitCount < 10) {
        const count = await page.evaluate(() => window.__ARCHIVER_STATE__?.getCount() || 0);
        if (count > 0) {
            console.log(`已捕获 ${count} 条初始消息`);
            break;
        }
        waitCount++;
        await delay(1000);
    }

    // 加载上次归档状态，确定截止时间
    let stopTimestamp = 0;
    let lastState = null;
    if (fs.existsSync(stateFile)) {
        try {
            lastState = JSON.parse(fs.readFileSync(stateFile, 'utf-8'));
            stopTimestamp = lastState.lastTimestamp || 0;
            console.log(`上次归档截止: ${new Date(stopTimestamp).toLocaleString('zh-CN')}`);
        } catch {}
    }
    if (!stopTimestamp) {
        stopTimestamp = Date.now() - 7 * 24 * 3600 * 1000;
        console.log(`首次运行，拉取最近 7 天消息`);
    }
    console.log(`截止时间戳: ${stopTimestamp}`);

    // 从浏览器获取 cookies，用于 Node.js 端 HTTP 请求
    const browserCookies = cookieStore.filterWeiboCookies(await browser.cookies());
    const cookieHeader = cookieStore.cookieHeader(browserCookies);

    // Node.js 端 HTTP 请求函数
    function httpsGet(url) {
        return new Promise((resolve, reject) => {
            const req = https.get(url, {
                headers: {
                    'Cookie': cookieHeader,
                    'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36',
                    'Referer': 'https://api.weibo.com/chat',
                    'X-Requested-With': 'XMLHttpRequest',
                },
            }, (res) => {
                // 必须攒 Buffer 再整体解码：`data += chunk` 会把每个 chunk 单独
                // toString('utf8')，中文字跨 chunk 边界时两半各自解码失败 → ���。
                // 实测已因此写坏 446 条消息（见 lib/read-stream.js）。
                readUtf8(res).then(
                    body => resolve({ status: res.statusCode, body }),
                    reject
                );
            });
            req.on('error', reject);
            req.setTimeout(30000, () => { req.destroy(); reject(new Error('timeout')); });
        });
    }

    // API 分页获取（Node.js 端，不依赖浏览器 fetch）。
    // 状态机本体在 lib/paginate.js（注入式测试覆盖）；这里只组装依赖。
    // 单页请求的唯一入口。翻页推进逻辑保持单一实现
    // （旧版把整套推进逻辑在 catch 里复制了一份，两份状态机极易走偏）。
    // 限流（429/418）与偶发 5xx 用指数退避重试；其余错误按原样单次重试。
    // 之前撞上限流只会立刻重试一次然后放弃 —— 分页就此残缺，state 不推进，
    // 下轮再来又是同样的节奏，等于反复撞墙。
    async function fetchPage(url) {
        const RATE_LIMITED = new Set([429, 418]);
        let lastErr = null;
        for (let attempt = 0; attempt < 4; attempt++) {
            if (attempt > 0) await delay(Math.min(2000 * 2 ** (attempt - 1), 16000));
            try {
                const resp = await httpsGet(url);
                if (RATE_LIMITED.has(resp.status) || resp.status >= 500) {
                    lastErr = new Error(`HTTP ${resp.status}`);
                    console.log(`[API] ${RATE_LIMITED.has(resp.status) ? '被限流' : '服务端错误'} ${resp.status}，退避重试`);
                    continue;
                }
                return { status: resp.status, data: JSON.parse(resp.body) };
            } catch (e) {
                lastErr = e;
                console.log(`[API] 请求失败: ${e.message}，退避重试`);
            }
        }
        throw lastErr || new Error('fetchPage 未取到响应');
    }

    const { messages: allApiMessages, paginationComplete, paginationNote } =
        await paginateMessages({
            groupId,
            stopTimestamp,
            fetchPage,
            normalize: normalizeMessage,
            sleep: delay,
        });
    console.log(`API 分页获取完成: ${allApiMessages.length} 条消息`
        + (paginationComplete ? '' : ` (未走完: ${paginationNote})`));

    // 一条都没抓到、而且分页是被错误打断的 → 本群这一轮是失败而不是"没有新消息"。
    // 抛出去交给单群重试；重试仍不行才计入 skippedGroups（退出码非 0）。
    // 不抛的话这种情况和"群里确实没新消息"长得一模一样，于是静默空跑。
    if (allApiMessages.length === 0 && !paginationComplete) {
        throw new Error(`未取到任何消息（${paginationNote}）`);
    }

    // 合并 API 分页消息和已捕获的脚本层消息
    const scriptMessages = await page.evaluate(() => window.__ARCHIVER_STATE__?.getMessages() || []);
    console.log(`脚本层消息: ${scriptMessages.length} 条`);
    console.log(`网络层消息: ${networkMessages.length} 条`);

    // 合并去重：API 分页 + 脚本层 + 网络层。
    // 三条来源已经是同构记录，整条存入即可 —— 旧版对脚本层显式重建对象、
    // 只挑 8 个字段，把仅被页内 hook 捕获到的 pics/share/link/videoUrl/avatar
    // 全部丢掉，落盘后 viewer 里就是空白气泡。
    const allMessages = new Map();
    for (const m of allApiMessages) allMessages.set(String(m.id), m);
    for (const m of scriptMessages) {
        if (!allMessages.has(String(m.id))) allMessages.set(String(m.id), m);
    }
    for (const m of networkMessages) {
        if (!allMessages.has(String(m.id))) allMessages.set(String(m.id), m);
    }

    const messages = [...allMessages.values()].sort((a, b) => a.timestamp - b.timestamp);
    console.log(`去重后总计: ${messages.length} 条消息`);

    if (messages.length > 0) {
        const groups = {};
        for (const msg of messages) {
            const date = msg.date || 'unknown';
            if (!groups[date]) groups[date] = [];
            groups[date].push(msg);
        }

        for (const [date, msgs] of Object.entries(groups)) {
            // mergeIntoDayFile 负责：区分"文件不存在"与"解析失败"（后者备份成
            // .corrupt.<ts> 而不是当空文件覆盖掉整天历史）+ 按 id 去重 + 原子落盘
            const dayFile = path.join(groupDir, `weibo_chat_${date}.json`);
            const { existing, total } = mergeIntoDayFile(dayFile, msgs);
            console.log(`  ${date}: 原有 ${existing} + 本轮 ${msgs.length} → ${total} 条`);
        }
        console.log(`已按天拆分保存 ${Object.keys(groups).length} 个文件`);

        // 保存归档状态：记录最新消息的时间戳，下次从这里继续。
        // 只有分页真正走完才推进 —— 否则断点与上次截止时间之间的消息会被
        // 永久跳过（下次运行的 stopTimestamp 已经越过它们了）。
        const newestTs = messages[messages.length - 1]?.timestamp;
        if (!paginationComplete) {
            console.warn(`⚠ 分页未走完(${paginationNote})，保留原有归档状态，下次运行会重新补齐这段区间`);
        } else if (!Number.isFinite(newestTs)) {
            console.warn('⚠ 最新消息缺少有效 timestamp，保留原有归档状态（不用 Date.now() 兜底，否则会跳过整段区间）');
        } else {
            const newState = {
                lastRun: new Date().toISOString(),
                lastMessageCount: messages.length,
                lastTimestamp: newestTs,
                // groupId 供查看器的实时同步用：它没有浏览器可点，只能靠归档器
                // 把切群时解析到的会话 id 记下来（缺失时实时同步对该群自动关闭）
                groupId: String(groupId),
            };
            writeJsonAtomic(stateFile, newState);
            console.log(`归档状态已保存 (截止: ${new Date(newState.lastTimestamp).toLocaleString('zh-CN')})`);
        }

        // 后台更新 QA 话题块索引(fire-and-forget:失败只警告,不影响归档;
        // 没跑成也无妨——qa-agent 检测到索引过期会自动降级为即时切块)
        try {
            const updatedDates = Object.keys(groups).join(',');
            spawn(process.execPath, [
                path.join(ROOT, 'scripts', 'build-qa-index.mjs'),
                '--group', currentGroupName,
                '--dates', updatedDates,
            ], { detached: true, stdio: 'ignore' }).unref();
            console.log(`已触发 QA 索引更新 (${Object.keys(groups).length} 天)`);
        } catch (e) {
            console.warn('QA 索引更新触发失败(不影响归档):', e.message);
        }
    }

    // 记录已完成的群 id：只在归档真正走完后登记，否则失败重试时会把自己
    // 上一次尝试的 id 当成"别的群占用了"，误判成串档。
    archivedGroupIds.set(groupId, currentGroupName);
    groupDone = true;

    } catch (e) {
        if (e.fatal) throw e;   // Cookie 失效之类：重试无意义，立即上抛
        console.error(`✗ 群「${currentGroupName}」本次失败: ${e.message}`);
        if (attempt >= GROUP_RETRIES) {
            skippedGroups.push(`${currentGroupName}(${e.message.slice(0, 60)})`);
        }
    }
    } // end retry attempts
    } // end for each group

    // 保存 Cookie（cookie-store 校验 SUB，失效会话不会覆盖有效登录）
    if (cookieStore.saveCookies(cookieStore.filterWeiboCookies(await browser.cookies()), '归档完成续期').ok) {
        console.log('下次运行将自动使用已保存的登录状态');
    }

    // 会话保活：归档全程只碰 api.weibo.com（从不下发 Set-Cookie），weibo.com
    // 侧的 24h 滚动会话必须单独续，否则次日就 21301 要求重新扫码
    try {
        const r = await weiboAuth.refreshSession();
        if (r.renewed) console.log(`[keepalive] 已续期 ${r.renewed} 项会话 Cookie`);
    } catch (e) {
        console.log(`[keepalive] 会话续期失败（不影响本轮归档）: ${e.message}`);
    }

    // 关闭浏览器
    } finally {
        await browser.close().catch(() => {});
    }
    // 仅 macOS：归档结束后重新唤起用户的 Chrome（历史行为，其它平台无需）
    if (process.platform === 'darwin') {
        console.log('重新打开 Chrome...');
        exec('open -a "Google Chrome"');
    }

    if (skippedGroups.length > 0) {
        // 有群没归档成功就必须失败，否则调度器只会看到退出码 0。
        // 但整轮重跑没有意义：每个群都已就地重试过（GROUP_RETRIES），
        // 重跑只会把成功的群再抓一遍、再等 30 秒。
        const e = new Error(`${skippedGroups.length}/${GROUPS.length} 个群未归档: ${skippedGroups.join('、')}`);
        e.alreadyRetried = true;
        throw e;
    }

    console.log('完成！');
}

async function runWithRetry(maxRetries = 1) {
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
        try {
            await main();
            return;
        } catch (err) {
            // 重试无意义的两类错误：Cookie 失效（fatal）、单群已就地重试过
            // （alreadyRetried）—— 都只会白等 30 秒再开一次浏览器
            if (attempt < maxRetries && !err.fatal && !err.alreadyRetried) {
                console.error(`尝试 ${attempt + 1} 失败:`, err.message);
                console.log('30秒后重试...');
                await new Promise(r => setTimeout(r, 30000));
            } else {
                throw err;
            }
        }
    }
}

// 跨进程互斥：定时任务与手动 Sync 无论从哪条路进来都只能有一个实例在跑。
// 锁包在 runWithRetry 外层（而非 main 内），否则重试轮次会撞上自己的锁。
const lockResult = syncLock.acquireLock(path.join(ROOT, 'state'));
if (!lockResult.ok) {
    console.error(`另一个归档进程正在运行，本次退出（${lockResult.reason}）`);
    process.exit(1);
}

runWithRetry()
    .catch(err => {
        console.error('错误:', err);
        process.exitCode = 1;
    })
    .finally(() => {
        syncLock.releaseLock(path.join(ROOT, 'state'));
    });
