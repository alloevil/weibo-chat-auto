// 用 Puppeteer 打开可见 Chrome 让用户扫码登录微博，成功后自动保存 cookies.json。
// 供 viewer-server 的 /api/browser-login 调用（浏览器版“登录”按钮），
// 与命令行 save-cookies.js 等价，但无需用户手动敲命令。
'use strict';

const path = require('path');
const { resolveChromePath } = require('./chrome-path');
const cookieStore = require('./cookie-store');
const weiboAuth = require('./weibo-auth');

const ROOT = path.join(__dirname, '..');
const chatUrl = 'https://api.weibo.com/chat#/chat';

// 单例锁，避免重复点击开出多个浏览器
let inProgress = false;

async function browserLogin() {
    if (inProgress) return { ok: false, error: '登录窗口已打开，请在浏览器中完成扫码' };
    inProgress = true;

    let browser;
    try {
        let puppeteer;
        try {
            puppeteer = require('puppeteer');
        } catch {
            // 桌面应用的 sidecar 是 Bun 编译的独立二进制，未打包 puppeteer。
            // 这种情况说明是从桌面 app 的端口用浏览器访问——应直接用 app 窗口登录。
            return { ok: false, error: '当前由桌面应用提供服务，请在桌面应用窗口内点击登录；若要用浏览器扫码，请改用 npm run view 启动。' };
        }
        let configChromePath = '';
        try { configChromePath = require(path.join(ROOT, 'config.json')).chromePath; } catch { /* 可缺省 */ }
        const chromePath = resolveChromePath(configChromePath);

        browser = await puppeteer.launch({
            headless: false,
            executablePath: chromePath,
            defaultViewport: null,
            args: ['--no-first-run', '--window-size=1280,800'],
        });

        const page = await browser.newPage();
        await page.goto(chatUrl, { waitUntil: 'networkidle2', timeout: 30000 });

        // 登录态判据统一走 lib/weibo-auth（接口 error_code）。
        // 旧版的 alreadyLoggedIn 用 innerText.substring(0, 200) 再判
        // length > 200，恒为 false；等待条件 text.length > 500 也只是
        // DOM 猜测，渲染慢就白等 10 分钟，而 inProgress 单例锁会让
        // /api/browser-login 在这期间一直回"登录窗口已打开"。
        if (await weiboAuth.isAuthenticated(page) !== true) {
            if (!await weiboAuth.waitForAuth(page, { timeoutMs: 600000 })) {
                return { ok: false, error: '等待扫码登录超时（10 分钟）' };
            }
            await new Promise(r => setTimeout(r, 5000));
        }

        // browser.cookies() 取全量（含 HttpOnly），过滤微博相关域并去重。
        // （page.cookies(url) 在 puppeteer 24 已弃用）
        const cookies = cookieStore.filterWeiboCookies(await browser.cookies());

        // cookie-store 统一校验 SUB + 域名补前导点
        const saved = cookieStore.saveCookies(cookies, '浏览器扫码登录');
        if (!saved.ok) {
            return { ok: false, error: '未检测到登录态（SUB），请重试' };
        }
        return { ok: true, count: saved.count };
    } catch (e) {
        return { ok: false, error: e.message };
    } finally {
        if (browser) { try { await browser.close(); } catch { /* ignore */ } }
        inProgress = false;
    }
}

module.exports = { browserLogin };
