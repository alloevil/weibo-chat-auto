const puppeteer = require('puppeteer');

const chatUrl = 'https://api.weibo.com/chat#/chat';
const { resolveChromePath } = require('./lib/chrome-path');
const cookieStore = require('./lib/cookie-store');
let configChromePath = '';
try { configChromePath = require('./config.json').chromePath; } catch { /* config 可缺省，靠探测 */ }
const chromePath = resolveChromePath(configChromePath);

async function saveCookies() {
    console.log('=== 保存微博 Cookie ===');
    console.log('将打开浏览器，请用微博 App 扫码登录\n');

    const browser = await puppeteer.launch({
        headless: false,
        executablePath: chromePath,
        defaultViewport: null,
        args: ['--no-first-run', '--window-size=1280,800'],
    });

    const page = await browser.newPage();
    await page.goto(chatUrl, { waitUntil: 'networkidle2', timeout: 30000 });

    // 检查是否已登录（页面出现具体群聊名说明已进入聊天列表）
    const bodyText = await page.evaluate(() => document.body.innerText.substring(0, 200));
    const alreadyLoggedIn = !bodyText.includes('扫描登录') && !bodyText.includes('立即注册') && bodyText.length > 200;

    if (!alreadyLoggedIn) {
        console.log('========================================');
        console.log('请在浏览器窗口中用微博 App 扫码登录');
        console.log('登录后会自动保存 Cookie');
        console.log('========================================');
        // 等待登录成功：登录页包含"扫描登录"，登录后跳转到聊天列表
        await page.waitForFunction(() => {
            const text = document.body.innerText;
            if (text.includes('扫描登录') || text.includes('立即注册')) return false;
            return text.length > 500;
        }, { timeout: 600000 });
        console.log('✓ 登录成功！等待页面稳定...');
        await new Promise(r => setTimeout(r, 5000));
    } else {
        console.log('✓ 已检测到登录状态');
    }

    // 从所有相关域名收集 Cookie（认证 Cookie 分散在多个域名）
    const domains = [
        'https://api.weibo.com',
        'https://weibo.com',
        'https://passport.weibo.com',
        'https://login.sina.com.cn',
    ];
    let allCookies = [];
    for (const d of domains) {
        try { allCookies.push(...await page.cookies(d)); } catch {}
    }
    // 去重（domain + name）
    const seen = new Set();
    const cookies = allCookies.filter(c => {
        const key = c.domain + '|' + c.name;
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
    });

    // cookie-store 统一校验 SUB + 域名补前导点
    const saved = cookieStore.saveCookies(cookies, '手动扫码');
    if (saved.ok) {
        console.log(`Cookie 已保存到: ${cookieStore.COOKIE_FILE}`);
    } else {
        console.log('保存失败：' + saved.error);
        process.exitCode = 1;
    }

    await browser.close();
}

saveCookies().catch(err => {
    console.error('错误:', err);
    process.exit(1);
});
