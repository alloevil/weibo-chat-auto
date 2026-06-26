// 录制脱敏演示 GIF（Linear 深色主题）。不触碰 output/ 真实数据。
// 用法：node docs/gen-demo-gif.js   依赖：puppeteer + gifski
const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFile, execFileSync } = require('child_process');

const TMP = path.join(os.tmpdir(), 'weibo-gif-' + Date.now());
const FRAMES = path.join(TMP, 'frames');
const GROUP = '开源茶馆演示群';
const GROUP_DIR = path.join(TMP, GROUP);
fs.mkdirSync(GROUP_DIR, { recursive: true });
fs.mkdirSync(FRAMES, { recursive: true });

const users = ['林青禾', 'Kev_码农', '阿渡', '半夏', 'tomo', '老白'];
const lines = [
    '今天试了下新出的本地模型，推理速度比上周快不少',
    '有人用过 Tauri 打包桌面应用吗？体积比 Electron 小好多',
    'Rust 的所有权刚开始劝退，习惯了真香',
    '周末整理了一下 dotfiles，终于把终端配置统一了',
    '@Kev_码农 那个 CI 的缓存问题解决了吗',
    '解决了，是 lockfile 没提交导致每次重装依赖 😂',
    '深色主题看久了眼睛确实舒服',
    '分享个排版小技巧：负字距用在大标题上很提质感',
    '这个热力图做得不错，一眼看出大家几点最活跃',
    '增量归档这个思路好，断点续传不怕中断',
    '图片防盗链可以本地代理绕过，加个 referrer 处理就行',
    '晚上一起 review 下那个 PR？',
    '好啊，我把改动拆成几个小 commit 方便看',
    '收到，辛苦啦 🙏',
];
const day = '2026-06-20';
const base = new Date(day + 'T09:00:00+08:00').getTime();
const msgs = [];
for (let i = 0; i < 60; i++) {
    const u = users[(i * 7 + 3) % users.length];
    const ts = base + i * (1000 * 60 * (8 + (i % 5) * 6));
    const d = new Date(ts);
    msgs.push({
        id: 900000 + i, from_uid: 1000 + (i % 6), user: u, avatar: '',
        timestamp: ts,
        time: `${day.replace(/-/g, '/')} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}:00`,
        date: day, content: lines[i % lines.length], type: 321, pics: [],
    });
}
fs.writeFileSync(path.join(GROUP_DIR, `weibo_chat_${day}.json`), JSON.stringify(msgs));

const PORT = 3998;
const srv = execFile('node', [path.join(__dirname, '..', 'viewer-server.js')], {
    env: { ...process.env, WEIBO_OUTPUT_DIR: TMP, WEIBO_PORT: String(PORT) },
});
srv.stderr.on('data', d => process.stderr.write('[srv:err] ' + d));

const sleep = ms => new Promise(r => setTimeout(r, ms));

(async () => {
    const puppeteer = require('puppeteer');
    await sleep(1500);
    const exe = process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
    const browser = await puppeteer.launch({
        headless: 'new', executablePath: exe,
        args: ['--no-sandbox', '--disable-setuid-sandbox', '--force-color-profile=srgb'],
        defaultViewport: { width: 1280, height: 800, deviceScaleFactor: 1 },
    });
    const page = await browser.newPage();
    await page.goto(`http://localhost:${PORT}`, { waitUntil: 'networkidle2', timeout: 30000 });
    await page.waitForSelector('.msg-item', { timeout: 15000 });
    await sleep(1200);

    let n = 0;
    const shot = async () => { await page.screenshot({ path: path.join(FRAMES, `f${String(n++).padStart(3, '0')}.png`) }); };
    const hold = async (frames) => { for (let i = 0; i < frames; i++) await shot(); };

    // 场景1：消息视图停留
    await hold(6);
    // 场景2：缓慢向下滚动消息列表
    const msgsEl = '.messages';
    for (let i = 0; i < 10; i++) {
        await page.evaluate((sel) => { document.querySelector(sel).scrollTop += 110; }, msgsEl);
        await sleep(120); await shot();
    }
    await hold(3);
    // 场景3：打开上下文面板
    await page.evaluate(() => { document.querySelector('.msg-ctx-link')?.click(); });
    await sleep(350);
    await hold(8);
    // 关闭上下文
    await page.evaluate(() => { document.querySelector('.ctx-close')?.click(); });
    await sleep(250);
    // 场景4：切换到统计面板
    await page.evaluate(() => document.getElementById('statsToggle')?.click());
    await sleep(500);
    await hold(10);
    // 统计面板内滚动一点
    for (let i = 0; i < 5; i++) {
        await page.evaluate(() => { document.querySelector('.stats-panel').scrollTop += 120; });
        await sleep(120); await shot();
    }
    await hold(6);

    await browser.close();
    srv.kill();

    // 合成 GIF：先缩放帧到宽 960，再用 gifski
    const out = path.join(__dirname, 'demo.gif');
    console.log(`[gif] ${n} frames captured, encoding...`);
    execFileSync('gifski', [
        '--fps', '10', '--width', '800', '--quality', '75',
        '-o', out, path.join(FRAMES, 'f*.png'),
    ], { stdio: 'inherit', shell: true });

    fs.rmSync(TMP, { recursive: true, force: true });
    const kb = (fs.statSync(out).size / 1024).toFixed(0);
    console.log(`[gif] done: ${out} (${kb} KB)`);
    process.exit(0);
})().catch(e => { console.error(e); srv.kill(); fs.rmSync(TMP, { recursive: true, force: true }); process.exit(1); });
