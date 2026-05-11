const puppeteer = require('puppeteer');
const fs = require('fs');
const path = require('path');

const cookieFile = path.join(__dirname, 'cookies.json');
const chatUrl = 'https://api.weibo.com/chat#/chat';
const chromePath = require('./config.json').chromePath;

async function saveCookies() {
    console.log('=== 保存微博 Cookie ===');
    console.log('将打开浏览器，请手动登录微博');
    console.log('登录完成后，Cookie 会自动保存\n');

    const browser = await puppeteer.launch({
        headless: false,
        executablePath: chromePath,
        defaultViewport: null,
        args: ['--no-sandbox', '--window-size=1280,800'],
    });

    const page = await browser.newPage();
    await page.goto(chatUrl, { waitUntil: 'networkidle2' });

    console.log('请在浏览器中登录微博...');
    console.log('登录成功后，按 Ctrl+C 保存 Cookie 并退出\n');

    // 等待用户登录
    await page.waitForFunction(() => {
        return !document.querySelector('.login-btn') &&
               !document.querySelector('[class*="login"]');
    }, { timeout: 600000 }); // 10 分钟超时

    // 保存 Cookie
    const cookies = await page.cookies();
    fs.writeFileSync(cookieFile, JSON.stringify(cookies, null, 2));
    console.log(`Cookie 已保存到: ${cookieFile}`);
    console.log(`共 ${cookies.length} 个 Cookie`);

    await browser.close();
}

saveCookies().catch(err => {
    console.error('错误:', err);
    process.exit(1);
});
