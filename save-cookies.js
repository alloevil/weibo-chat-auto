const puppeteer = require('puppeteer');
const fs = require('fs');
const path = require('path');
const os = require('os');

const cookieFile = path.join(__dirname, 'cookies.json');
const chatUrl = 'https://api.weibo.com/chat#/chat';
const chromePath = require('./config.json').chromePath;

// Chrome 用户 profile 路径（复用已登录的会话）
const userDataDir = path.join(os.homedir(), 'Library', 'Application Support', 'Google', 'Chrome');

async function saveCookies() {
    console.log('=== 保存微博 Cookie ===');
    console.log('将使用你的 Chrome profile（复用已登录状态）\n');

    // 检查 Chrome 是否正在运行
    const { execSync } = require('child_process');
    let chromeRunning = false;
    try {
        const ps = execSync('pgrep -f "Google Chrome" | head -1').toString().trim();
        chromeRunning = !!ps;
    } catch {}

    if (chromeRunning) {
        console.log('⚠️  检测到 Chrome 正在运行。');
        console.log('请先关闭 Chrome，然后重新运行此命令。\n');
        console.log('（因为 Chrome 会锁定 profile，无法同时使用）');
        process.exit(1);
    }

    const browser = await puppeteer.launch({
        headless: false,
        executablePath: chromePath,
        defaultViewport: null,
        userDataDir: userDataDir,
        args: ['--no-first-run', '--window-size=1280,800'],
    });

    const page = await browser.newPage();
    await page.goto(chatUrl, { waitUntil: 'networkidle2' });

    // 检查是否已登录
    const bodyText = await page.evaluate(() => document.body.innerText.substring(0, 100));
    if (bodyText.includes('扫描登录') || bodyText.includes('登录/注册')) {
        console.log('请在浏览器中登录微博...');
        console.log('登录成功后，按 Ctrl+C 保存 Cookie 并退出\n');
        await page.waitForFunction(() => {
            return !document.body.innerText.includes('扫描登录');
        }, { timeout: 600000 });
    } else {
        console.log('✓ 已检测到登录状态');
    }

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
