const puppeteer = require('puppeteer');
const fs = require('fs');
const path = require('path');

// 配置
const CONFIG = {
    // 微博聊天页面 URL
    chatUrl: 'https://api.weibo.com/chat#/chat',
    // Cookie 文件路径
    cookieFile: path.join(__dirname, 'cookies.json'),
    // 输出目录
    outputDir: path.join(__dirname, 'output'),
    // Chrome 路径
    chromePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    // Chrome 远程调试端口
    chromeDebugPort: 9222,
    // 要归档的群聊名称
    groupName: '茧房建筑师协会',
    // 自动滚动间隔 (ms)
    scrollInterval: 1500,
    // 最大连续无新消息次数
    maxNoNewCount: 5,
    // 是否显示浏览器 (false = 无头模式)
    headless: false,
    // 浏览器启动延迟 (ms)
    launchDelay: 3000,
    // 加载完成后等待时间 (ms)
    loadWaitTime: 2000,
};

// 用户脚本内容 (内联注入)
const USER_SCRIPT = `
// 微博聊天归档脚本 - Puppeteer 版
(function() {
    'use strict';

    const STORAGE_KEY = '_weibo_chat_archiver_msgs';
    const MSG_API_REGEX = /\\/webim\\/groupchat\\/query_messages\\.json/;
    const MEDIA_URL_KEYS = [
        'pic_url', 'original_pic', 'large_url', 'image',
        'file_url', 'attachment', 'attach', 'file',
        'voice_url', 'audio', 'video_url', 'video'
    ];

    let messages = [];
    let messageIds = new Set();
    let mediaQueue = [];
    let downloadedMedia = new Set();
    let downloadStats = { images: 0, files: 0, failed: 0 };

    // 暴露给 Puppeteer
    window.__ARCHIVER_STATE__ = {
        messages: [],
        messageIds: new Set(),
        getCount: () => messages.length,
        getMessages: () => messages,
        clearMessages: () => {
            messages = [];
            messageIds = new Set();
            window.__ARCHIVER_STATE__.messages = [];
            window.__ARCHIVER_STATE__.messageIds = new Set();
        }
    };

    function getMsgId(msg) {
        return msg?.id || msg?.mid || msg?.message_id || null;
    }

    function getTimestamp(msg) {
        if (typeof msg.time === 'number' && msg.time > 0) {
            return msg.time * 1000;
        }
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
            for (const url of imgMatches) {
                urls.push({ url, type: 'image' });
            }
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
            id,
            from_uid: msg.from_uid || fromUser.id || null,
            user: fromUser.screen_name || fromUser.name || msg.from_uid || '未知用户',
            timestamp: ts,
            time: formatTime(ts),
            date: formatDate(ts),
            content: getMsgContent(msg),
            type: msg.type || msg.msg_type || 'text',
            media_urls: media.map(m => m.url),
            media
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

    // Hook fetch
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

    // Hook XHR
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

// 延迟函数
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

// 主函数
async function main() {
    console.log('=== 微博聊天自动归档 ===');
    console.log('启动时间:', new Date().toLocaleString('zh-CN'));

    // 确保输出目录存在
    if (!fs.existsSync(CONFIG.outputDir)) {
        fs.mkdirSync(CONFIG.outputDir, { recursive: true });
    }

    // 启动浏览器（复制 Chrome 配置）
    console.log('启动浏览器...');
    const tempChromeDir = path.join(__dirname, 'temp-chrome');

    // 如果临时目录存在，先删除
    if (fs.existsSync(tempChromeDir)) {
        fs.rmSync(tempChromeDir, { recursive: true, force: true });
    }

    // 复制 Chrome 配置（只复制必要的文件）
    const chromeUserDir = path.join(process.env.HOME, 'Library/Application Support/Google/Chrome/Default');
    if (fs.existsSync(chromeUserDir)) {
        console.log('复制 Chrome 配置...');
        fs.mkdirSync(path.join(tempChromeDir, 'Default'), { recursive: true });

        // 复制 Cookie 和登录状态文件
        const filesToCopy = ['Cookies', 'Login Data', 'Web Data', 'Preferences'];
        for (const file of filesToCopy) {
            const src = path.join(chromeUserDir, file);
            const dest = path.join(tempChromeDir, 'Default', file);
            if (fs.existsSync(src)) {
                fs.copyFileSync(src, dest);
            }
        }
    }

    const browser = await puppeteer.launch({
        headless: CONFIG.headless ? 'new' : false,
        executablePath: CONFIG.chromePath,
        defaultViewport: null,
        userDataDir: tempChromeDir,
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

    // 等待页面加载
    console.log('等待页面加载...');
    await delay(CONFIG.launchDelay + 2000);

    // 检查页面标题确认是否加载成功
    const title = await page.title();
    console.log('页面标题:', title);

    // 截图以便调试
    const screenshotPath = path.join(__dirname, 'debug-screenshot.png');
    await page.screenshot({ path: screenshotPath, fullPage: false });
    console.log(`截图已保存: ${screenshotPath}`);

    // 自动点击群聊
    console.log(`查找群聊: ${CONFIG.groupName}...`);
    const groupClicked = await page.evaluate((groupName) => {
        // 查找所有可能的群聊元素
        const selectors = [
            '[class*="chat-item"]',
            '[class*="group-item"]',
            '[class*="session-item"]',
            '[class*="conversation-item"]',
            'li[class*="item"]',
            'div[class*="item"]',
        ];

        for (const selector of selectors) {
            const items = document.querySelectorAll(selector);
            for (const item of items) {
                const text = item.textContent || item.innerText || '';
                if (text.includes(groupName)) {
                    console.log('找到群聊，点击...');
                    item.click();
                    return true;
                }
            }
        }

        // 如果上面没找到，尝试查找所有可点击元素
        const allElements = document.querySelectorAll('div, li, a, span');
        for (const el of allElements) {
            const text = el.textContent || el.innerText || '';
            if (text.includes(groupName) && el.offsetHeight > 0) {
                console.log('找到群聊元素，点击...');
                el.click();
                return true;
            }
        }

        return false;
    }, CONFIG.groupName);

    if (groupClicked) {
        console.log('✓ 已点击群聊');
        await delay(2000); // 等待群聊加载
    } else {
        console.log('⚠ 未找到群聊，请手动点击');
        console.log('等待 30 秒供手动操作...');
        await delay(30000);
    }

    // 注入用户脚本
    console.log('注入归档脚本...');
    await page.evaluate(USER_SCRIPT);

    // 等待脚本初始化
    await delay(1000);

    // 开始自动滚动加载历史消息
    console.log('开始自动加载历史消息...');
    let noNewCount = 0;
    let lastCount = 0;

    while (true) {
        // 获取当前消息数
        const currentCount = await page.evaluate(() => {
            return window.__ARCHIVER_STATE__?.getCount() || 0;
        });

        console.log(`当前消息数: ${currentCount}`);

        // 滚动到顶部
        await page.evaluate(() => {
            const container = document.querySelector('[class*="chat-list"]') ||
                            document.querySelector('[class*="message-list"]') ||
                            document.querySelector('[class*="msg-list"]') ||
                            document.querySelector('[class*="chat-content"]');
            if (container) {
                container.scrollTop = 0;
            }
        });

        // 等待加载
        await delay(CONFIG.scrollInterval);

        // 检查是否有新消息
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
        lastCount = newCount;
    }

    // 获取所有消息
    console.log('导出消息...');
    const messages = await page.evaluate(() => {
        return window.__ARCHIVER_STATE__?.getMessages() || [];
    });

    console.log(`总共捕获 ${messages.length} 条消息`);

    if (messages.length > 0) {
        // 按日期分组
        const groups = {};
        for (const msg of messages) {
            const date = msg.date || formatDate(msg.timestamp);
            if (!groups[date]) groups[date] = [];
            groups[date].push(msg);
        }

        // 保存为 JSON 文件
        const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
        const filename = `weibo_chat_${timestamp}.json`;
        const filepath = path.join(CONFIG.outputDir, filename);

        fs.writeFileSync(filepath, JSON.stringify({
            exportTime: new Date().toISOString(),
            totalMessages: messages.length,
            dateRange: {
                start: messages[0]?.time,
                end: messages[messages.length - 1]?.time,
            },
            days: Object.keys(groups).length,
            messages: messages,
        }, null, 2));

        console.log(`已保存到: ${filepath}`);

        // 同时保存按天拆分的文件
        for (const [date, msgs] of Object.entries(groups)) {
            const dayFile = path.join(CONFIG.outputDir, `weibo_chat_${date}.json`);
            fs.writeFileSync(dayFile, JSON.stringify(msgs, null, 2));
        }
        console.log(`已按天拆分保存 ${Object.keys(groups).length} 个文件`);
    }

    // 保存最新 Cookie
    const cookies = await page.cookies();
    fs.writeFileSync(CONFIG.cookieFile, JSON.stringify(cookies, null, 2));

    // 关闭浏览器
    await browser.close();
    console.log('完成！');
}

// 运行
main().catch(err => {
    console.error('错误:', err);
    process.exit(1);
});
