const puppeteer = require('puppeteer');
const fs = require('fs');
const path = require('path');
const { execSync, exec } = require('child_process');

// 配置
const CONFIG = {
    chatUrl: 'https://api.weibo.com/chat#/chat',
    outputDir: path.join(__dirname, 'output'),
    chromePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    chromeUserDir: path.join(process.env.HOME, 'Library/Application Support/Google/Chrome'),
    groupName: '茧房建筑师协会',
    scrollInterval: 1500,
    maxNoNewCount: 5,
    launchDelay: 3000,
};

// 延迟函数
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

// 用户脚本（同之前）
const USER_SCRIPT = `
// 微博聊天归档脚本
(function() {
    'use strict';
    const MSG_API_REGEX = /\\/webim\\/groupchat\\/query_messages\\.json/;
    let messages = [];
    let messageIds = new Set();
    window.__ARCHIVER_STATE__ = {
        messages: [],
        getCount: () => messages.length,
        getMessages: () => messages,
    };

    function getMsgId(msg) { return msg?.id || msg?.mid || msg?.message_id || null; }
    function getTimestamp(msg) {
        if (typeof msg.time === 'number' && msg.time > 0) return msg.time * 1000;
        if (msg.created_at) { const t = Date.parse(msg.created_at); if (!isNaN(t)) return t; }
        return Date.now();
    }
    function formatTime(ts) {
        return new Date(ts).toLocaleString('zh-CN', {
            year: 'numeric', month: '2-digit', day: '2-digit',
            hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false
        });
    }
    function formatDate(ts) {
        const d = new Date(ts);
        return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
    }
    function getMsgContent(msg) { return (msg?.content ?? msg?.text ?? msg?.message ?? msg?.body ?? '').replace(/[\\r\\n]+/g, ' ').replace(/\\s+/g, ' ').trim(); }

    function normalizeMessage(msg) {
        const id = getMsgId(msg);
        if (!id || messageIds.has(String(id))) return null;
        messageIds.add(String(id));
        const ts = getTimestamp(msg);
        const fromUser = msg.from_user || {};
        return {
            id, from_uid: msg.from_uid || fromUser.id || null,
            user: fromUser.screen_name || fromUser.name || msg.from_uid || '未知用户',
            timestamp: ts, time: formatTime(ts), date: formatDate(ts),
            content: getMsgContent(msg), type: msg.type || msg.msg_type || 'text'
        };
    }

    function handleApiResponse(data) {
        const msgs = data.messages || data.data?.messages || data.data || [];
        const msgList = Array.isArray(msgs) ? msgs : (Array.isArray(data.list) ? data.list : []);
        let added = 0;
        for (const m of msgList) {
            const n = normalizeMessage(m);
            if (n) { messages.push(n); window.__ARCHIVER_STATE__.messages.push(n); added++; }
        }
        if (added > 0) {
            messages.sort((a, b) => a.timestamp - b.timestamp);
            window.__ARCHIVER_STATE__.messages.sort((a, b) => a.timestamp - b.timestamp);
            console.log('[Archiver] 新增 ' + added + ' 条，总计 ' + messages.length);
        }
    }

    const origFetch = window.fetch;
    window.fetch = async function (...args) {
        const resp = await origFetch.apply(this, args);
        try {
            let url = typeof args[0] === 'string' ? args[0] : args[0]?.url || '';
            if (url && MSG_API_REGEX.test(url)) {
                resp.clone().json().then(handleApiResponse).catch(() => {});
            }
        } catch {}
        return resp;
    };

    const origOpen = XMLHttpRequest.prototype.open;
    XMLHttpRequest.prototype.open = function (m, url, ...r) { this._url = url; return origOpen.apply(this, [m, url, ...r]); };
    const origSend = XMLHttpRequest.prototype.send;
    XMLHttpRequest.prototype.send = function (...a) {
        this.addEventListener('load', function () {
            try { const url = this._url || this.responseURL || ''; if (url && MSG_API_REGEX.test(url)) handleApiResponse(JSON.parse(this.responseText)); } catch {}
        });
        return origSend.apply(this, a);
    };
    console.log('[Archiver] 脚本已注入');
})();
`;

async function main() {
    console.log('=== 微博聊天自动归档 ===');
    console.log('启动时间:', new Date().toLocaleString('zh-CN'));

    if (!fs.existsSync(CONFIG.outputDir)) {
        fs.mkdirSync(CONFIG.outputDir, { recursive: true });
    }

    // 检查 Chrome 是否在运行
    console.log('检查 Chrome 状态...');
    let chromeRunning = false;
    try {
        const result = execSync('pgrep -x "Google Chrome"', { encoding: 'utf-8' }).trim();
        chromeRunning = result.length > 0;
    } catch (e) {
        chromeRunning = false;
    }

    if (chromeRunning) {
        console.log('⚠️  检测到 Chrome 正在运行，自动关闭...');
        try {
            execSync('pkill -x "Google Chrome"', { encoding: 'utf-8' });
        } catch (e) {
            // Chrome may not close immediately
        }
        console.log('等待 Chrome 完全关闭...');
        await delay(3000);
    }

    // 启动浏览器（使用用户 Chrome 配置）
    console.log('启动浏览器...');
    const browser = await puppeteer.launch({
        headless: false,
        executablePath: CONFIG.chromePath,
        defaultViewport: null,
        userDataDir: CONFIG.chromeUserDir,
        args: [
            '--no-sandbox',
            '--disable-setuid-sandbox',
            '--window-size=1280,800',
        ],
    });

    const page = await browser.newPage();

    // 导航到聊天页面
    console.log('打开微博聊天页面...');
    await page.goto(CONFIG.chatUrl, {
        waitUntil: 'networkidle2',
        timeout: 30000,
    });

    await delay(CONFIG.launchDelay + 2000);

    const title = await page.title();
    console.log('页面标题:', title);

    // 截图
    await page.screenshot({ path: path.join(__dirname, 'debug.png'), fullPage: false });

    // 自动点击群聊
    console.log(`查找群聊: ${CONFIG.groupName}...`);
    const groupClicked = await page.evaluate((groupName) => {
        const allElements = document.querySelectorAll('div, li, a, span');
        for (const el of allElements) {
            if (el.childElementCount === 0) {
                const text = (el.textContent || '').trim();
                if (text === groupName && el.offsetHeight > 0) {
                    el.click();
                    return true;
                }
            }
        }
        return false;
    }, CONFIG.groupName);

    if (groupClicked) {
        console.log('✓ 已点击群聊');
        await delay(3000);
    } else {
        console.log('⚠ 未找到群聊，请手动点击');
        console.log('等待 30 秒供手动操作...');
        await delay(30000);
    }

    // 注入脚本
    console.log('注入归档脚本...');
    await page.evaluate(USER_SCRIPT);
    await delay(1000);

    // 自动滚动加载历史消息
    console.log('开始自动加载历史消息...');
    let noNewCount = 0;

    while (true) {
        const currentCount = await page.evaluate(() => window.__ARCHIVER_STATE__?.getCount() || 0);
        console.log(`当前消息数: ${currentCount}`);

        await page.evaluate(() => {
            const container = document.querySelector('[class*="chat-list"]') ||
                            document.querySelector('[class*="message-list"]') ||
                            document.querySelector('[class*="msg-list"]') ||
                            document.querySelector('[class*="chat-content"]');
            if (container) container.scrollTop = 0;
        });

        await delay(CONFIG.scrollInterval);

        const newCount = await page.evaluate(() => window.__ARCHIVER_STATE__?.getCount() || 0);

        if (newCount === currentCount) {
            noNewCount++;
            if (noNewCount >= CONFIG.maxNoNewCount) {
                console.log('已到达最早消息，停止加载');
                break;
            }
        } else {
            noNewCount = 0;
        }
    }

    // 导出消息
    console.log('导出消息...');
    const messages = await page.evaluate(() => window.__ARCHIVER_STATE__?.getMessages() || []);
    console.log(`总共捕获 ${messages.length} 条消息`);

    if (messages.length > 0) {
        const groups = {};
        for (const msg of messages) {
            const date = msg.date || 'unknown';
            if (!groups[date]) groups[date] = [];
            groups[date].push(msg);
        }

        const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
        const filepath = path.join(CONFIG.outputDir, `weibo_chat_${timestamp}.json`);

        fs.writeFileSync(filepath, JSON.stringify({
            exportTime: new Date().toISOString(),
            totalMessages: messages.length,
            days: Object.keys(groups).length,
            messages: messages,
        }, null, 2));

        console.log(`已保存到: ${filepath}`);

        for (const [date, msgs] of Object.entries(groups)) {
            fs.writeFileSync(path.join(CONFIG.outputDir, `weibo_chat_${date}.json`), JSON.stringify(msgs, null, 2));
        }
        console.log(`已按天拆分保存 ${Object.keys(groups).length} 个文件`);
    }

    // 关闭浏览器
    await browser.close();

    // 重新打开 Chrome
    console.log('重新打开 Chrome...');
    exec(`open -a "Google Chrome"`);

    console.log('完成！');
}

main().catch(err => {
    console.error('错误:', err);
    process.exit(1);
});
