const puppeteer = require('puppeteer');
const fs = require('fs');
const path = require('path');
const { execSync, spawn } = require('child_process');

// 配置
const CONFIG = {
    chatUrl: 'https://api.weibo.com/chat#/chat',
    outputDir: path.join(__dirname, 'output'),
    chromePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    chromeDebugPort: 9222,
    groupName: '茧房建筑师协会',
    scrollInterval: 1500,
    maxNoNewCount: 5,
    launchDelay: 3000,
};

// 延迟函数
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

// 用户脚本内容 (内联注入)
const USER_SCRIPT = `
// 微博聊天归档脚本 - Puppeteer 版
(function() {
    'use strict';

    const MSG_API_REGEX = /\\/webim\\/groupchat\\/query_messages\\.json/;
    const MEDIA_URL_KEYS = [
        'pic_url', 'original_pic', 'large_url', 'image',
        'file_url', 'attachment', 'attach', 'file',
        'voice_url', 'audio', 'video_url', 'video'
    ];

    let messages = [];
    let messageIds = new Set();

    window.__ARCHIVER_STATE__ = {
        messages: [],
        getCount: () => messages.length,
        getMessages: () => messages,
    };

    function getMsgId(msg) {
        return msg?.id || msg?.mid || msg?.message_id || null;
    }

    function getTimestamp(msg) {
        if (typeof msg.time === 'number' && msg.time > 0) return msg.time * 1000;
        if (msg.created_at) {
            const t = Date.parse(msg.created_at);
            if (!isNaN(t)) return t;
        }
        return Date.now();
    }

    function formatTime(ts) {
        return new Date(ts).toLocaleString('zh-CN', {
            year: 'numeric', month: '2-digit', day: '2-digit',
            hour: '2-digit', minute: '2-digit', second: '2-digit',
            hour12: false
        });
    }

    function formatDate(ts) {
        const d = new Date(ts);
        return d.getFullYear() + '-' +
            String(d.getMonth() + 1).padStart(2, '0') + '-' +
            String(d.getDate()).padStart(2, '0');
    }

    function getMsgContent(msg) {
        const raw = msg?.content ?? msg?.text ?? msg?.message ?? msg?.body ?? '';
        return raw.replace(/[\\r\\n]+/g, ' ').replace(/\\s+/g, ' ').trim();
    }

    function extractMediaUrls(msg) {
        const urls = [];
        for (const key of MEDIA_URL_KEYS) {
            const val = msg[key];
            if (typeof val === 'string' && val.startsWith('http')) {
                urls.push({ url: val, type: guessMediaType(key, val) });
            }
        }
        for (const key of ['pic', 'file', 'attach', 'attachment', 'large', 'original']) {
            const obj = msg[key];
            if (obj && typeof obj === 'object') {
                const url = obj.url || obj.pic_url || obj.original_url || obj.download_url;
                if (url && typeof url === 'string' && url.startsWith('http')) {
                    urls.push({ url, type: guessMediaType(key, url) });
                }
            }
        }
        const content = msg?.content || msg?.text || '';
        const imgMatches = content.match(/https?:\\/\\/[^\\s"'<>]+\\.(jpg|jpeg|png|gif|webp|bmp)/gi);
        if (imgMatches) {
            for (const url of imgMatches) urls.push({ url, type: 'image' });
        }
        const seen = new Set();
        return urls.filter(item => {
            if (seen.has(item.url)) return false;
            seen.add(item.url);
            return true;
        });
    }

    function guessMediaType(key, url) {
        if (key.includes('pic') || key.includes('image') || key.includes('large')) return 'image';
        if (key.includes('voice') || key.includes('audio')) return 'audio';
        if (key.includes('video')) return 'video';
        if (key.includes('file') || key.includes('attach')) return 'file';
        if (/\\.(jpg|jpeg|png|gif|webp|bmp)/i.test(url)) return 'image';
        if (/\\.(mp3|wav|amr|aac)/i.test(url)) return 'audio';
        if (/\\.(mp4|mov|avi)/i.test(url)) return 'video';
        return 'file';
    }

    function normalizeMessage(msg) {
        const id = getMsgId(msg);
        if (!id) return null;
        if (messageIds.has(String(id))) return null;

        messageIds.add(String(id));
        const ts = getTimestamp(msg);
        const fromUser = msg.from_user || {};
        const media = extractMediaUrls(msg);

        return {
            id, from_uid: msg.from_uid || fromUser.id || null,
            user: fromUser.screen_name || fromUser.name || msg.from_uid || '未知用户',
            timestamp: ts, time: formatTime(ts), date: formatDate(ts),
            content: getMsgContent(msg),
            type: msg.type || msg.msg_type || 'text',
            media_urls: media.map(m => m.url), media
        };
    }

    function handleApiResponse(data) {
        const msgs = data.messages || data.data?.messages || data.data || [];
        const msgList = Array.isArray(msgs) ? msgs : (Array.isArray(data.list) ? data.list : []);
        if (msgList.length === 0) return 0;

        let added = 0;
        for (const m of msgList) {
            const normalized = normalizeMessage(m);
            if (normalized) {
                messages.push(normalized);
                window.__ARCHIVER_STATE__.messages.push(normalized);
                added++;
            }
        }
        if (added > 0) {
            messages.sort((a, b) => a.timestamp - b.timestamp);
            window.__ARCHIVER_STATE__.messages.sort((a, b) => a.timestamp - b.timestamp);
            console.log('[Archiver] 新增 ' + added + ' 条消息，总计 ' + messages.length);
        }
        return added;
    }

    const origFetch = window.fetch;
    window.fetch = async function (...args) {
        const response = await origFetch.apply(this, args);
        try {
            let url = '';
            if (typeof args[0] === 'string') url = args[0];
            else if (args[0] instanceof Request) url = args[0].url;
            if (url && MSG_API_REGEX.test(url)) {
                const clone = response.clone();
                clone.json().then(data => handleApiResponse(data)).catch(() => {});
            }
        } catch {}
        return response;
    };

    const origXhrOpen = XMLHttpRequest.prototype.open;
    XMLHttpRequest.prototype.open = function (method, url, ...rest) {
        this._archiver_url = url;
        return origXhrOpen.apply(this, [method, url, ...rest]);
    };

    const origXhrSend = XMLHttpRequest.prototype.send;
    XMLHttpRequest.prototype.send = function (...args) {
        this.addEventListener('load', function () {
            try {
                const url = this._archiver_url || this.responseURL || '';
                if (url && MSG_API_REGEX.test(url)) {
                    const data = JSON.parse(this.responseText);
                    handleApiResponse(data);
                }
            } catch {}
        });
        return origXhrSend.apply(this, args);
    };

    console.log('[Archiver] 脚本已注入');
})();
`;

async function main() {
    console.log('=== 微博聊天自动归档 ===');
    console.log('启动时间:', new Date().toLocaleString('zh-CN'));

    // 确保输出目录存在
    if (!fs.existsSync(CONFIG.outputDir)) {
        fs.mkdirSync(CONFIG.outputDir, { recursive: true });
    }

    // 检查 Chrome 是否已以调试模式运行
    let chromeRunning = false;
    try {
        execSync(`lsof -i :${CONFIG.chromeDebugPort}`, { stdio: 'pipe' });
        chromeRunning = true;
    } catch (e) {
        // Chrome 未以调试模式运行
    }

    if (!chromeRunning) {
        console.log('请先以调试模式启动 Chrome:');
        console.log(`"${CONFIG.chromePath}" --remote-debugging-port=${CONFIG.chromeDebugPort}`);
        console.log('\n或者使用以下命令启动:');
        console.log(`npm run start-chrome\n`);
        process.exit(1);
    }

    // 连接到 Chrome
    console.log('连接到 Chrome...');
    const browser = await puppeteer.connect({
        browserURL: `http://127.0.0.1:${CONFIG.chromeDebugPort}`,
        defaultViewport: null,
    });

    // 创建新标签页
    const page = await browser.newPage();

    // 导航到聊天页面
    console.log('打开微博聊天页面...');
    await page.goto(CONFIG.chatUrl, {
        waitUntil: 'networkidle2',
        timeout: 30000,
    });

    // 等待页面加载
    console.log('等待页面加载...');
    await delay(CONFIG.launchDelay + 2000);

    // 检查页面标题
    const title = await page.title();
    console.log('页面标题:', title);

    // 截图
    const screenshotPath = path.join(__dirname, 'debug-screenshot.png');
    await page.screenshot({ path: screenshotPath, fullPage: false });
    console.log(`截图已保存: ${screenshotPath}`);

    // 自动点击群聊
    console.log(`查找群聊: ${CONFIG.groupName}...`);
    const groupClicked = await page.evaluate((groupName) => {
        const selectors = [
            '[class*="chat-item"]', '[class*="group-item"]',
            '[class*="session-item"]', '[class*="conversation-item"]',
            'li[class*="item"]', 'div[class*="item"]',
        ];

        for (const selector of selectors) {
            const items = document.querySelectorAll(selector);
            for (const item of items) {
                const text = item.textContent || item.innerText || '';
                if (text.includes(groupName)) {
                    item.click();
                    return true;
                }
            }
        }

        const allElements = document.querySelectorAll('div, li, a, span');
        for (const el of allElements) {
            if (el.childElementCount === 0) {
                const text = el.textContent || el.innerText || '';
                if (text.trim() === groupName && el.offsetHeight > 0) {
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
        console.log('等待 60 秒供手动操作...');
        await delay(60000);
    }

    // 注入脚本
    console.log('注入归档脚本...');
    await page.evaluate(USER_SCRIPT);
    await delay(1000);

    // 自动滚动加载历史消息
    console.log('开始自动加载历史消息...');
    let noNewCount = 0;

    while (true) {
        const currentCount = await page.evaluate(() => {
            return window.__ARCHIVER_STATE__?.getCount() || 0;
        });

        console.log(`当前消息数: ${currentCount}`);

        await page.evaluate(() => {
            const container = document.querySelector('[class*="chat-list"]') ||
                            document.querySelector('[class*="message-list"]') ||
                            document.querySelector('[class*="msg-list"]') ||
                            document.querySelector('[class*="chat-content"]');
            if (container) container.scrollTop = 0;
        });

        await delay(CONFIG.scrollInterval);

        const newCount = await page.evaluate(() => {
            return window.__ARCHIVER_STATE__?.getCount() || 0;
        });

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
    const messages = await page.evaluate(() => {
        return window.__ARCHIVER_STATE__?.getMessages() || [];
    });

    console.log(`总共捕获 ${messages.length} 条消息`);

    if (messages.length > 0) {
        const groups = {};
        for (const msg of messages) {
            const date = msg.date || formatDate(msg.timestamp);
            if (!groups[date]) groups[date] = [];
            groups[date].push(msg);
        }

        const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
        const filename = `weibo_chat_${timestamp}.json`;
        const filepath = path.join(CONFIG.outputDir, filename);

        fs.writeFileSync(filepath, JSON.stringify({
            exportTime: new Date().toISOString(),
            totalMessages: messages.length,
            dateRange: { start: messages[0]?.time, end: messages[messages.length - 1]?.time },
            days: Object.keys(groups).length,
            messages: messages,
        }, null, 2));

        console.log(`已保存到: ${filepath}`);

        for (const [date, msgs] of Object.entries(groups)) {
            const dayFile = path.join(CONFIG.outputDir, `weibo_chat_${date}.json`);
            fs.writeFileSync(dayFile, JSON.stringify(msgs, null, 2));
        }
        console.log(`已按天拆分保存 ${Object.keys(groups).length} 个文件`);
    }

    // 关闭标签页（不关闭浏览器）
    await page.close();
    console.log('完成！');
}

main().catch(err => {
    console.error('错误:', err);
    process.exit(1);
});
