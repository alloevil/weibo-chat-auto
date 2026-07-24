// 扫码登录 weibo.com 主站(与群聊的 api.weibo.com/chat 登录完全独立,见
// weibo-cookies.mjs 顶部说明),供 fetch-posts.mjs 使用。
//
// 用法: node foodmap/login.mjs
import path from 'path';
import { fileURLToPath } from 'url';
import { createRequire } from 'module';
import * as weiboCookies from './weibo-cookies.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = __dirname;
const require = createRequire(import.meta.url);
const { resolveChromePath } = require('./lib/chrome-path.js');

async function main() {
  const puppeteer = require('puppeteer');
  let configChromePath = '';
  try { configChromePath = require(path.join(ROOT, 'config.json')).chromePath; } catch { /* 可缺省 */ }
  const chromePath = resolveChromePath(configChromePath);

  const browser = await puppeteer.launch({
    headless: false,
    executablePath: chromePath,
    defaultViewport: null,
    args: ['--no-first-run', '--window-size=1280,900'],
  });

  try {
    const page = await browser.newPage();
    await page.goto('https://weibo.com/', { waitUntil: 'networkidle2', timeout: 30000 });

    // 扫码成功的瞬间页面正在跳转,这时调用 evaluate 会撞上"执行上下文已被
    // 导航销毁"的报错——这是正常的时序竞态,不是真的检测失败,吞掉这个
    // 错误当作"还没确定登录,下一轮再看"就行,不能让它中断整个登录流程
    const isLoggedIn = () => page.evaluate(() => {
      // 登录页会跳到 weibo.com/newlogin...;已登录的首页 URL 不含 login
      if (location.href.includes('login')) return false;
      return document.body.innerText.length > 300;
    }).catch(() => null);

    if (await isLoggedIn()) {
      console.log('检测到已登录');
    } else {
      console.log('请在弹出的浏览器窗口扫码登录 weibo.com...');
      const maxWait = 300000;
      const start = Date.now();
      let loggedIn = false;
      while (Date.now() - start < maxWait) {
        await new Promise(r => setTimeout(r, 3000));
        if (await isLoggedIn()) { loggedIn = true; break; }
      }
      if (!loggedIn) { console.error('等待登录超时'); process.exitCode = 1; return; }
      console.log('检测到已登录！');
      await new Promise(r => setTimeout(r, 3000));
    }

    const cookies = weiboCookies.filterWeiboCookies(await browser.cookies());
    const saved = weiboCookies.saveCookies(cookies, 'weibo.com 主站扫码登录');
    if (!saved.ok) { console.error('保存失败:', saved.error); process.exitCode = 1; return; }
    console.log(`已保存 ${saved.count} 个 Cookie 到 ${weiboCookies.COOKIE_FILE}`);
  } finally {
    await browser.close();
  }
}

main().catch(e => { console.error(e); process.exit(1); });
