const puppeteer = require('puppeteer');
const path = require('path');
const { resolveChromePath } = require('./lib/chrome-path');
let cfgChrome = '';
try { cfgChrome = require('./config.json').chromePath; } catch { /* 靠探测 */ }

(async () => {
    const browser = await puppeteer.launch({
        headless: 'new',
        executablePath: resolveChromePath(cfgChrome),
        args: ['--no-sandbox', '--disable-setuid-sandbox', '--window-size=1280,900'],
    });
    const page = await browser.newPage();
    await page.setViewport({ width: 1280, height: 900 });
    await page.goto('http://localhost:3456', { waitUntil: 'networkidle2', timeout: 30000 });
    await page.waitForSelector('.msg-item', { timeout: 10000 });
    await new Promise(r => setTimeout(r, 2000));

    // Heavy redaction: blur all user content
    await page.addStyleTag({ content: `
        .msg-item * { filter: blur(20px) !important; user-select: none !important; pointer-events: none !important; }
        .msg-item .msg-link { filter: blur(25px) !important; }
        .msg-item img { filter: blur(25px) !important; }
        .msg-item .forward-quote * { filter: blur(20px) !important; }
        .share-card * { filter: blur(10px) !important; }
        .forward-quote * { filter: blur(10px) !important; }
        .user-avatar, .user-avatar img { filter: blur(10px) !important; }
        .user-item { color: transparent !important; text-shadow: 0 0 10px rgba(0,0,0,0.6) !important; }
        /* Keep structural elements visible */
        .nav-title, .calendar, .hour-bar, .sidebar-title, .media-bar, .filter-bar { filter: none !important; color: inherit !important; text-shadow: none !important; }
    ` });
    await new Promise(r => setTimeout(r, 500));

    await page.screenshot({ path: path.join(__dirname, 'screenshot.png'), fullPage: false });
    console.log('Screenshot saved');
    await browser.close();
})();
