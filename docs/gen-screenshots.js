// 生成脱敏演示数据 + 截图，用于 README 预览。完全不触碰 output/ 真实数据。
// 用法：node docs/gen-screenshots.js
const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');

const TMP = path.join(require('os').tmpdir(), 'weibo-demo-' + Date.now());
const GROUP = '开源茶馆演示群';
const GROUP_DIR = path.join(TMP, GROUP);
fs.mkdirSync(GROUP_DIR, { recursive: true });

// 虚构成员（与任何真实用户无关）
const users = [
    { user: '林青禾', uid: 1001 },
    { user: 'Kev_码农', uid: 1002 },
    { user: '阿渡', uid: 1003 },
    { user: '半夏', uid: 1004 },
    { user: 'tomo', uid: 1005 },
    { user: '老白', uid: 1006 },
];
// 通用技术闲聊语料（无任何真实信息）
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
// 长尾活跃度分布（少数人话多），让排名角标和活跃度条有区分度
const weights = [12, 9, 7, 5, 3, 2];
const pool = [];
users.forEach((u, i) => { for (let k = 0; k < weights[i]; k++) pool.push(u); });
for (let i = 0; i < 48; i++) {
    const u = pool[(i * 13 + 5) % pool.length];
    const ts = base + i * (1000 * 60 * (8 + (i % 5) * 6)); // 分散到全天
    const d = new Date(ts);
    msgs.push({
        id: 900000 + i,
        from_uid: u.uid,
        user: u.user,
        avatar: '', // 留空 → 用首字母色块头像，无需外部图片
        timestamp: ts,
        time: `${day.replace(/-/g, '/')} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}:00`,
        date: day,
        content: lines[i % lines.length],
        type: 321,
        pics: [],
    });
}
fs.writeFileSync(path.join(GROUP_DIR, `weibo_chat_${day}.json`), JSON.stringify(msgs, null, 2));
console.log('[demo] wrote', msgs.length, 'fake messages to', GROUP_DIR);

// 启动一个临时服务器实例（独立端口 + 指向假数据目录）
const PORT = 3999;
const srv = execFile('node', [path.join(__dirname, '..', 'viewer-server.js')], {
    env: { ...process.env, WEIBO_OUTPUT_DIR: TMP, WEIBO_PORT: String(PORT) },
});
srv.stdout.on('data', d => process.stdout.write('[srv] ' + d));
srv.stderr.on('data', d => process.stderr.write('[srv:err] ' + d));

(async () => {
    const puppeteer = require('puppeteer');
    await new Promise(r => setTimeout(r, 1500));
    const exe = process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
    const browser = await puppeteer.launch({
        headless: 'new',
        executablePath: exe,
        args: ['--no-sandbox', '--disable-setuid-sandbox', '--window-size=1440,960', '--force-color-profile=srgb'],
        defaultViewport: { width: 1440, height: 960, deviceScaleFactor: 2 },
    });
    const page = await browser.newPage();
    const url = `http://localhost:${PORT}`;
    await page.goto(url, { waitUntil: 'networkidle2', timeout: 30000 });
    await page.waitForSelector('.msg-item', { timeout: 15000 });
    await new Promise(r => setTimeout(r, 1500));

    // 1) 消息视图
    await page.screenshot({ path: path.join(__dirname, 'screenshot-messages.png') });
    console.log('[shot] messages');

    // 2) 统计面板
    await page.evaluate(() => document.getElementById('statsToggle')?.click());
    await new Promise(r => setTimeout(r, 1200));
    await page.screenshot({ path: path.join(__dirname, 'screenshot-stats.png') });
    console.log('[shot] stats');

    // 3) 上下文聚焦面板：关掉统计回到消息，点第一条的「上下文」入口
    await page.evaluate(() => document.getElementById('statsToggle')?.click());
    await new Promise(r => setTimeout(r, 800));
    await page.evaluate(() => {
        const link = document.querySelector('.msg-ctx-link') || document.querySelector('.msg-ctx-btn');
        if (link) link.click();
    });
    await new Promise(r => setTimeout(r, 1000));
    await page.screenshot({ path: path.join(__dirname, 'screenshot-context.png') });
    console.log('[shot] context');

    await browser.close();
    srv.kill();
    fs.rmSync(TMP, { recursive: true, force: true });
    console.log('[demo] cleaned up', TMP);
    process.exit(0);
})().catch(e => { console.error(e); srv.kill(); fs.rmSync(TMP, { recursive: true, force: true }); process.exit(1); });
