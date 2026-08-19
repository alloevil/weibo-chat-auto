const puppeteer = require('puppeteer');

const chatUrl = 'https://api.weibo.com/chat#/chat';
const { resolveChromePath } = require('../lib/chrome-path');
const cookieStore = require('../lib/cookie-store');
const weiboAuth = require('../lib/weibo-auth');
let configChromePath = '';
try { configChromePath = require('../config.json').chromePath; } catch { /* config 可缺省，靠探测 */ }
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

    // 登录态判据统一走 lib/weibo-auth（接口 error_code）。
    // 旧版用 innerText.substring(0, 200) 再判 length > 200，恒为 false，
    // 于是已登录也会进入等待分支；而等待条件 text.length > 500 同样是
    // DOM 文案猜测，聊天页渲染慢或改版就会白等满 10 分钟。
    if (await weiboAuth.isAuthenticated(page) === true) {
        console.log('✓ 已检测到登录状态');
    } else {
        console.log('========================================');
        console.log('请在浏览器窗口中用微博 App 扫码登录');
        console.log('登录后会自动保存 Cookie');
        console.log('========================================');
        if (!await weiboAuth.waitForAuth(page, { timeoutMs: 600000 })) {
            console.log('等待登录超时（10 分钟）');
            await browser.close();
            process.exit(1);
        }
        console.log('✓ 登录成功！等待页面稳定...');
        await new Promise(r => setTimeout(r, 5000));
    }

    // browser.cookies() 取全量（含 HttpOnly），过滤微博相关域并去重
    // （page.cookies(url) 在 puppeteer 24 已弃用）
    const cookies = cookieStore.filterWeiboCookies(await browser.cookies());

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
