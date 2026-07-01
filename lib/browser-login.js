// 用 Puppeteer 打开可见 Chrome 让用户扫码登录微博，成功后自动保存 cookies.json。
// 供 viewer-server 的 /api/browser-login 调用（浏览器版“登录”按钮），
// 与命令行 save-cookies.js 等价，但无需用户手动敲命令。
'use strict';

const fs = require('fs');
const path = require('path');
const { resolveChromePath } = require('./chrome-path');

const ROOT = path.join(__dirname, '..');
const cookieFile = path.join(ROOT, 'cookies.json');
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

        const bodyText = await page.evaluate(() => document.body.innerText.substring(0, 200));
        const alreadyLoggedIn = !bodyText.includes('扫描登录') && !bodyText.includes('立即注册') && bodyText.length > 200;

        if (!alreadyLoggedIn) {
            // 等待扫码完成：登录页含“扫描登录”，登录后跳转到聊天列表
            await page.waitForFunction(() => {
                const text = document.body.innerText;
                if (text.includes('扫描登录') || text.includes('立即注册')) return false;
                return text.length > 500;
            }, { timeout: 600000 });
            await new Promise(r => setTimeout(r, 5000));
        }

        const domains = [
            'https://api.weibo.com',
            'https://weibo.com',
            'https://passport.weibo.com',
            'https://login.sina.com.cn',
        ];
        let all = [];
        for (const d of domains) {
            try { all.push(...await page.cookies(d)); } catch { /* 忽略单域失败 */ }
        }
        const seen = new Set();
        const cookies = all.filter(c => {
            const key = c.domain + '|' + c.name;
            if (seen.has(key)) return false;
            seen.add(key);
            // 补前导点，保证 SUB 能发给 api.weibo.com 子域
            if (c.domain && !c.domain.startsWith('.') && c.domain.includes('.')) c.domain = '.' + c.domain;
            return true;
        });

        if (!cookies.some(c => c.name === 'SUB')) {
            return { ok: false, error: '未检测到登录态（SUB），请重试' };
        }

        fs.writeFileSync(cookieFile, JSON.stringify(cookies, null, 2));
        return { ok: true, count: cookies.length };
    } catch (e) {
        return { ok: false, error: e.message };
    } finally {
        if (browser) { try { await browser.close(); } catch { /* ignore */ } }
        inProgress = false;
    }
}

module.exports = { browserLogin };
