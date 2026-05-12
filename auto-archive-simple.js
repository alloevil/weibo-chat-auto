const puppeteer = require('puppeteer');
const fs = require('fs');
const path = require('path');
const https = require('https');
const { exec } = require('child_process');

// 配置
const CONFIG = {
    chatUrl: 'https://api.weibo.com/chat#/chat',
    outputDir: path.join(__dirname, 'output'),
    chromePath: require('./config.json').chromePath,
    cookieFile: path.join(__dirname, 'cookies.json'),
    launchDelay: 3000,
};

const configData = require('./config.json');
const GROUPS = configData.groups || [configData.groupName || '茧房建筑师协会'];

function getGroupOutputDir(groupName) {
    const safe = groupName.replace(/[^a-zA-Z0-9一-鿿]/g, '_');
    return path.join(CONFIG.outputDir, safe);
}

function getGroupStateFile(groupName) {
    const safe = groupName.replace(/[^a-zA-Z0-9一-鿿]/g, '_');
    return path.join(__dirname, `last-archive-state_${safe}.json`);
}

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

// 检测是否需要登录
async function checkLoginRequired(page) {
    return await page.evaluate(() => {
        // 检查 URL 是否跳转到登录页
        if (location.href.includes('login') || location.href.includes('passport')) return true;
        // 检查页面标题
        const title = document.title || '';
        if (title.includes('登录') || title.includes('login')) return true;
        return false;
    });
}

// 等待登录完成
async function waitForLogin(page) {
    console.log('');
    console.log('========================================');
    console.log('  需要登录微博');
    console.log('  请在弹出的浏览器窗口中扫码登录');
    console.log('  登录完成后脚本会自动继续');
    console.log('========================================');
    console.log('');

    // 等待：URL 不再包含 login/passport，且页面出现聊天相关内容
    const maxWait = 300000; // 5 分钟
    const startTime = Date.now();

    while (Date.now() - startTime < maxWait) {
        await delay(3000);

        const loggedIn = await page.evaluate(() => {
            const url = location.href;
            // 不在登录页
            if (url.includes('login') || url.includes('passport')) return false;
            // 页面标题不包含登录
            const title = document.title || '';
            if (title.includes('登录') || title.includes('login')) return false;
            // 找到聊天相关元素
            const has = document.querySelector('[class*="chat"]') ||
                       document.querySelector('[class*="session"]') ||
                       document.querySelector('[class*="message"]') ||
                       document.querySelector('[class*="weibo"]') ||
                       document.querySelector('#app');
            return !!has;
        });

        if (loggedIn) {
            console.log('检测到已登录！');

            // 等待页面完全加载
            await delay(3000);

            // 保存完整 Cookie
            const cookies = await page.cookies();
            fs.writeFileSync(CONFIG.cookieFile, JSON.stringify(cookies, null, 2));
            console.log(`已保存 ${cookies.length} 个 Cookie 到 cookies.json`);
            return true;
        }
    }

    console.log('等待登录超时（5分钟）');
    return false;
}

// 用户脚本（同之前）
const USER_SCRIPT = `
(function() {
    'use strict';
    const MSG_API_REGEX = new RegExp('/webim/groupchat/query_messages\\.json');
    let messages = [];
    let messageIds = new Set();
    window.__ARCHIVER_STATE__ = {
        messages: [],
        getCount: () => messages.length,
        getMessages: () => messages,
    };

    function getMsgId(msg) { return msg?.id || msg?.id_str || msg?.mid || msg?.message_id || null; }
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
        const fromUser = msg.from_user || msg.sender || {};

        const pics = [];
        if (msg.pic_urls && Array.isArray(msg.pic_urls)) {
            msg.pic_urls.forEach(p => { const u = p.url || p.pic || (typeof p === 'string' ? p : null); if (u) pics.push(u.replace(/^http:/, 'https:')); });
        }
        if (pics.length === 0 && msg.pic) pics.push(String(msg.pic).replace(/^http:/, 'https:'));

        // 从 fids 构建图片 URL（media_type=1 的图片消息）
        if (pics.length === 0 && msg.fids && Array.isArray(msg.fids)) {
            msg.fids.forEach(fid => {
                pics.push('https://upload.api.weibo.com/2/mss/msget?source=209678993&fid=' + fid);
            });
        }

        let shareInfo = null;
        if (msg.url_objects && msg.url_objects.length > 0) {
            const uo = msg.url_objects[0];
            const info = uo.info || {};
            const status = uo.status || {};
            const statusUser = status.user || {};
            const picIds = status.pic_ids || [];
            const picUrls = picIds.map(pid => 'https://wx1.sinaimg.cn/large/' + pid + '.jpg');
            shareInfo = {
                url: uo.url_ori || info.url_long || info.url_short || '',
                title: info.title || (status.text || '').substring(0, 100),
                description: info.description || '',
                author: statusUser.screen_name || '',
                authorAvatar: statusUser.avatar_hd || statusUser.avatar_large || '',
                text: (status.text || '').replace(/<[^>]+>/g, '').replace(/[\r\n]+/g, ' ').substring(0, 300),
                pics: picUrls,
                reposts: status.reposts_count || 0,
                comments: status.comments_count || 0,
                likes: status.attitudes_count || 0,
                region: status.region_name || '',
                created: status.created_at || '',
            };
        }

        // 提取视频/额外 URL
        let link = '';
        if (msg.url) link = String(msg.url).replace(/^http:/, 'https:');
        if (!link && msg.short_url) link = String(msg.short_url).replace(/^http:/, 'https:');

        // 从 url_objects 提取流媒体 URL（视频消息）
        let videoUrl = '';
        if (msg.url_objects && msg.url_objects.length > 0) {
            const uo = msg.url_objects[0];
            const info = uo.info || {};
            videoUrl = info.video_url || info.url_short || info.url_long || uo.url_ori || '';
            videoUrl = videoUrl.replace(/^http:/, 'https:');
        }

        const result = {
            id, from_uid: msg.from_uid || fromUser.id || fromUser.idstr || null,
            user: fromUser.screen_name || fromUser.name || msg.from_uid || '未知用户',
            avatar: fromUser.avatar_large || fromUser.avatar_hd || fromUser.profile_image_url || '',
            timestamp: ts, time: formatTime(ts), date: formatDate(ts),
            content: getMsgContent(msg), type: msg.type || msg.msg_type || 'text'
        };
        if (pics.length > 0) result.pics = pics;
        if (shareInfo) result.share = shareInfo;
        if (link) result.link = link;
        if (videoUrl) result.videoUrl = videoUrl;
        return result;
    }

    function handleApiResponse(data) {
        const msgs = data.messages || data.data?.messages || data.data || [];
        const msgList = Array.isArray(msgs) ? msgs : (Array.isArray(data.list) ? data.list : []);
        let added = 0;
        for (const m of msgList) {
            // DEBUG: 打印包含"微博"的原始消息结构
            const debugContent = (m.content ?? m.text ?? '').replace(/[\r\n]+/g, ' ');
            if (debugContent.includes('微博')) {
                console.log('[DEBUG] raw msg keys:', Object.keys(m).join(', '));
                console.log('[DEBUG] content:', debugContent.substring(0, 200));
                console.log('[DEBUG] url_objects:', JSON.stringify(m.url_objects).substring(0, 300));
                console.log('[DEBUG] object:', JSON.stringify(m.object).substring(0, 200));
                console.log('[DEBUG] page_id:', m.page_id, '| url:', m.url, '| short_url:', m.short_url);
            }
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

    // 启动浏览器（干净模式）
    console.log('启动浏览器...');
    const browser = await puppeteer.launch({
        headless: 'new',
        executablePath: CONFIG.chromePath,
        defaultViewport: null,
        protocolTimeout: 600000, // 10 分钟，用于大量消息分页
        args: [
            '--no-sandbox',
            '--disable-setuid-sandbox',
            '--window-size=1280,800',
        ],
    });

    const page = await browser.newPage();

    // Puppeteer 网络层消息捕获
    const networkMessages = [];
    const capturedApiUrls = []; // 完整捕获消息 API URL

    page.on('response', async (response) => {
        const url = response.url();

        // 捕获完整的 query_messages API URL
        if (/query_messages\.json/.test(url)) {
            capturedApiUrls.push(url);
        }

        if (/\/webim\/.*message|query_messages|groupchat.*message/i.test(url)) {
            try {
                const data = await response.json();
                const msgs = data.messages || data.data?.messages || data.data || [];
                const msgList = Array.isArray(msgs) ? msgs : (Array.isArray(data.list) ? data.list : []);
                for (const m of msgList) {
                    const id = m?.id || m?.mid || m?.message_id || null;
                    if (id) {
                        networkMessages.push({
                            id,
                            from_uid: m.from_uid || m.from_user?.id || null,
                            user: m.from_user?.screen_name || m.from_user?.name || m.from_uid || '未知',
                            content: (m.content ?? m.text ?? m.message ?? '').replace(/[\r\n]+/g, ' ').trim(),
                            time: typeof m.time === 'number' ? m.time * 1000 : Date.now(),
                        });
                    }
                }
            } catch {}
        }
    });

    // 加载 Cookie
    let cookieLoaded = false;
    if (fs.existsSync(CONFIG.cookieFile)) {
        console.log('加载 Cookie...');
        const cookies = JSON.parse(fs.readFileSync(CONFIG.cookieFile, 'utf-8'));
        if (cookies.length > 0) {
            await page.setCookie(...cookies);
            console.log(`已加载 ${cookies.length} 个 Cookie`);
            cookieLoaded = true;
        }
    }

    if (!cookieLoaded) {
        console.log('未找到 Cookie 文件，首次运行需要登录');
    }

    // 导航到聊天页面
    console.log('打开微博聊天页面...');
    await page.goto(CONFIG.chatUrl, {
        waitUntil: 'networkidle2',
        timeout: 60000,
    });

    await delay(CONFIG.launchDelay);

    let title = '';
    try {
        title = await page.title();
    } catch (e) {
        console.log('获取页面标题失败，继续执行...');
    }
    console.log('页面标题:', title);

    // 截图
    try {
        await page.screenshot({ path: path.join(__dirname, 'debug.png'), fullPage: false });
        console.log('截图已保存: debug.png');
    } catch (e) {
        console.log('截图失败，继续执行...');
    }

    // 检查是否需要登录
    let needLogin = false;
    try {
        needLogin = await checkLoginRequired(page);
    } catch (e) {
        console.log('检查登录状态失败，假设已登录...');
    }

    if (needLogin) {
        const loginOk = await waitForLogin(page);
        if (!loginOk) {
            console.log('登录失败，退出');
            await browser.close();
            process.exit(1);
        }

        // 登录成功后重新导航到聊天页
        await delay(2000);
        if (!page.url().includes('chat')) {
            console.log('导航到聊天页面...');
            await page.goto(CONFIG.chatUrl, {
                waitUntil: 'networkidle2',
                timeout: 60000,
            });
            await delay(CONFIG.launchDelay);
        }

        // 再截图确认
        await page.screenshot({ path: path.join(__dirname, 'debug.png'), fullPage: false });
        console.log('登录后截图已保存: debug.png');
    } else {
        console.log('登录状态正常');

        // 每次运行成功后也更新 Cookie
        const cookies = await page.cookies();
        fs.writeFileSync(CONFIG.cookieFile, JSON.stringify(cookies, null, 2));
        console.log(`Cookie 已更新 (${cookies.length} 个)`);
    }

    // 注入归档脚本（在点击群聊之前，这样可以捕获所有 API 响应）
    console.log('注入归档脚本...');
    await page.addScriptTag({ content: USER_SCRIPT });
    await delay(500);

    // 关闭可能存在的弹窗（如"扫码分享"等）
    await page.evaluate(() => {
        // 关闭模态弹窗
        document.querySelectorAll('[class*="modal"], [class*="dialog"], [class*="overlay"], [class*="popup"]').forEach(el => {
            if (el.offsetHeight > 0) {
                const closeBtn = el.querySelector('[class*="close"], [class*="dismiss"]');
                if (closeBtn) closeBtn.click();
            }
        });
        // 按 ESC 关闭弹窗
        document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', keyCode: 27, bubbles: true }));
    });
    await delay(500);

    console.log('目标群聊:', GROUPS.join(', '));

    for (const currentGroupName of GROUPS) {
    const groupDir = getGroupOutputDir(currentGroupName);
    const stateFile = getGroupStateFile(currentGroupName);
    if (!fs.existsSync(groupDir)) fs.mkdirSync(groupDir, { recursive: true });

    // 自动点击群聊
    console.log(`\n--- 归档群聊: ${currentGroupName} ---`);
    console.log(`查找群聊: ${currentGroupName}...`);
    await delay(1000);

    const groupClicked = await page.evaluate((groupName) => {
        // 方法1: 查找所有文本内容完全匹配的叶子元素
        const allElements = document.querySelectorAll('*');
        for (const el of allElements) {
            if (el.childElementCount === 0 || el.childElementCount === 1) {
                const text = (el.textContent || '').trim();
                if (text === groupName && el.offsetHeight > 0) {
                    // 向上找到可点击的容器
                    let target = el;
                    for (let i = 0; i < 5; i++) {
                        if (!target.parentElement) break;
                        target = target.parentElement;
                        if (target.tagName === 'LI' || target.tagName === 'A' ||
                            target.onclick || target.getAttribute('role') === 'listitem') {
                            target.click();
                            return { found: true, method: 'container' };
                        }
                    }
                    // 直接点击
                    el.click();
                    return { found: true, method: 'direct' };
                }
            }
        }

        // 方法2: 模糊匹配，查找包含群名的元素
        for (const el of allElements) {
            const text = (el.textContent || '').trim();
            if (text.includes(groupName) && text.length < groupName.length + 20 && el.offsetHeight > 0) {
                el.click();
                return { found: true, method: 'fuzzy' };
            }
        }

        return { found: false, method: 'none' };
    }, currentGroupName);

    if (groupClicked.found) {
        console.log(`✓ 已点击群聊 (方式: ${groupClicked.method})`);
        // 等待 API 响应
        await delay(5000);
    } else {
        console.log('⚠ 未找到群聊，请手动点击');
        console.log('等待 60 秒供手动操作...');
        await delay(60000);
    }

    // 自动加载历史消息 — 通过 API 直接分页获取
    console.log('开始通过 API 分页加载所有历史消息...');

    // 先等待初始消息加载，同时从页面获取 group_id 和 source 参数
    const apiInfo = await page.evaluate(() => {
        // 从页面中提取 group_id（从 URL hash 或 DOM）
        let groupId = null;

        // 方法1: 从已捕获的 API 请求中提取
        const entries = performance.getEntriesByType('resource');
        for (const entry of entries) {
            const match = entry.name.match(/query_messages\.json.*[?&]id=(\d+)/);
            if (match) {
                groupId = match[1];
                break;
            }
        }

        // 方法2: 从 Vue 实例中提取
        if (!groupId) {
            const app = document.querySelector('#app')?.__vue_app__ || document.querySelector('#app')?.__vue__;
            if (app) {
                // 遍历组件查找 group ID
                const text = document.body.innerHTML;
                const m = text.match(/gid[=:]\s*["']?(\d{10,})/);
                if (m) groupId = m[1];
            }
        }

        return {
            groupId,
            archiverCount: window.__ARCHIVER_STATE__?.getCount() || 0,
        };
    });

    let groupId = apiInfo.groupId;
    if (!groupId) {
        // 尝试从已看到的 API URL 中提取（上一次运行已知的 ID）
        console.log('未能从页面获取 group ID，使用已知 ID');
        groupId = '4761715839862414';
    }
    console.log(`群组 ID: ${groupId}`);

    // 等待初始消息加载
    let waitCount = 0;
    while (waitCount < 10) {
        const count = await page.evaluate(() => window.__ARCHIVER_STATE__?.getCount() || 0);
        if (count > 0) {
            console.log(`已捕获 ${count} 条初始消息`);
            break;
        }
        waitCount++;
        await delay(1000);
    }

    // 加载上次归档状态，确定截止时间
    let stopTimestamp = 0;
    let lastState = null;
    if (fs.existsSync(stateFile)) {
        try {
            lastState = JSON.parse(fs.readFileSync(stateFile, 'utf-8'));
            stopTimestamp = lastState.lastTimestamp || 0;
            console.log(`上次归档截止: ${new Date(stopTimestamp).toLocaleString('zh-CN')}`);
        } catch {}
    }
    if (!stopTimestamp) {
        stopTimestamp = Date.now() - 7 * 24 * 3600 * 1000;
        console.log(`首次运行，拉取最近 7 天消息`);
    }
    console.log(`截止时间戳: ${stopTimestamp}`);

    // 从浏览器获取 cookies，用于 Node.js 端 HTTP 请求
    const browserCookies = await page.cookies('https://api.weibo.com');
    const cookieHeader = browserCookies.map(c => `${c.name}=${c.value}`).join('; ');

    // Node.js 端 HTTP 请求函数
    function httpsGet(url) {
        return new Promise((resolve, reject) => {
            const req = https.get(url, {
                headers: {
                    'Cookie': cookieHeader,
                    'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36',
                    'Referer': 'https://api.weibo.com/chat',
                    'X-Requested-With': 'XMLHttpRequest',
                },
            }, (res) => {
                let data = '';
                res.on('data', chunk => data += chunk);
                res.on('end', () => resolve({ status: res.statusCode, body: data }));
            });
            req.on('error', reject);
            req.setTimeout(30000, () => { req.destroy(); reject(new Error('timeout')); });
        });
    }

    function normalizeMessage(m) {
        const id = m?.id || m?.mid || m?.message_id || null;
        if (!id) return null;
        const ts = (typeof m.time === 'number' && m.time > 0) ? m.time * 1000 :
            (m.created_at ? Date.parse(m.created_at) : Date.now());
        const fromUser = m.from_user || {};

        // 提取图片 URL
        const pics = [];
        if (m.pic_urls && Array.isArray(m.pic_urls)) {
            m.pic_urls.forEach(p => {
                const u = p.url || p.pic || p.large?.url || (typeof p === 'string' ? p : null);
                if (u) pics.push(u.replace(/^http:/, 'https:'));
            });
        }
        if (pics.length === 0 && m.pic) {
            pics.push(String(m.pic).replace(/^http:/, 'https:'));
        }

        // 从 fids 构建图片 URL（media_type=1 的图片消息）
        if (pics.length === 0 && m.fids && Array.isArray(m.fids)) {
            m.fids.forEach(fid => {
                pics.push('https://upload.api.weibo.com/2/mss/msget?source=209678993&fid=' + fid);
            });
        }

        // 提取分享内容（url_objects，media_type=14 时有值）
        let shareInfo = null;
        if (m.url_objects && m.url_objects.length > 0) {
            const uo = m.url_objects[0];
            const info = uo.info || {};
            const status = uo.status || {};
            const statusUser = status.user || {};
            const picIds = status.pic_ids || [];

            // 构建图片 URL（微博图片 CDN 格式）
            const picUrls = picIds.map(pid =>
                `https://wx1.sinaimg.cn/large/${pid}.jpg`
            );

            shareInfo = {
                url: uo.url_ori || info.url_long || info.url_short || '',
                title: info.title || (status.text || '').substring(0, 100),
                description: info.description || '',
                author: statusUser.screen_name || '',
                authorAvatar: statusUser.avatar_hd || statusUser.avatar_large || '',
                text: (status.text || '').replace(/<[^>]+>/g, '').replace(/[\r\n]+/g, ' ').substring(0, 300),
                pics: picUrls,
                reposts: status.reposts_count || 0,
                comments: status.comments_count || 0,
                likes: status.attitudes_count || 0,
                region: status.region_name || '',
                created: status.created_at || '',
            };
        }

        // 提取附加 URL
        let extraUrl = '';
        if (m.url) extraUrl = String(m.url).replace(/^http:/, 'https:');
        if (!extraUrl && m.short_url) extraUrl = String(m.short_url).replace(/^http:/, 'https:');

        // 从 url_objects 提取流媒体 URL（视频消息）
        let videoUrl = '';
        if (m.url_objects && m.url_objects.length > 0) {
            const uo = m.url_objects[0];
            const info = uo.info || {};
            videoUrl = info.video_url || info.url_short || info.url_long || uo.url_ori || '';
            videoUrl = videoUrl.replace(/^http:/, 'https:');
        }

        const result = {
            id,
            from_uid: m.from_uid || fromUser.id || fromUser.idstr || null,
            user: fromUser.screen_name || fromUser.name || m.from_uid || '未知用户',
            avatar: fromUser.avatar_large || fromUser.avatar_hd || fromUser.profile_image_url || '',
            timestamp: ts,
            time: new Date(ts).toLocaleString('zh-CN', { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false }),
            date: new Date(ts).getFullYear() + '-' + String(new Date(ts).getMonth() + 1).padStart(2, '0') + '-' + String(new Date(ts).getDate()).padStart(2, '0'),
            content: (m.content ?? m.text ?? m.message ?? m.body ?? '').replace(/[\r\n]+/g, ' ').replace(/\s+/g, ' ').trim(),
            type: m.type || m.msg_type || 'text',
        };

        // 只在有值时添加额外字段
        if (pics.length > 0) result.pics = pics;
        if (shareInfo) result.share = shareInfo;
        if (extraUrl && !result.content.includes(extraUrl)) result.link = extraUrl;
        if (videoUrl) result.videoUrl = videoUrl;

        return result;
    }

    // API 分页获取（Node.js 端，不依赖浏览器 fetch）
    const allApiMessages = [];
    const messageIds = new Set();
    let maxMid = null;
    let pageNum = 0;
    const MAX_PAGES = 500;
    const COUNT = 20;

    while (pageNum < MAX_PAGES) {
        let url = `https://api.weibo.com/webim/groupchat/query_messages.json?convert_emoji=1&query_sender=1&count=${COUNT}&id=${groupId}&max_mid=${maxMid || 0}`;
        url += `&source=209678993&t=${Date.now()}`;

        try {
            const resp = await httpsGet(url);
            const data = JSON.parse(resp.body);

            if (pageNum === 0) {
                console.log(`[API] 状态: ${resp.status}, keys: ${Object.keys(data).join(',')}`);
            }

            const rawMsgs = data.messages || data.data?.messages || data.data || [];
            const msgList = Array.isArray(rawMsgs) ? rawMsgs : (Array.isArray(data.list) ? data.list : []);

            if (msgList.length === 0) {
                console.log('[API] 无更多消息');
                break;
            }

            let added = 0;
            for (const m of msgList) {
                // DEBUG: 打印包含"微博"的原始消息结构
                const debugContent = (m.content ?? m.text ?? '').replace(/[\r\n]+/g, ' ');
                if (debugContent.includes('微博')) {
                    console.log('[DEBUG] raw msg keys:', Object.keys(m).join(', '));
                    console.log('[DEBUG] content:', debugContent.substring(0, 200));
                    console.log('[DEBUG] url_objects:', JSON.stringify(m.url_objects).substring(0, 500));
                    console.log('[DEBUG] object:', JSON.stringify(m.object).substring(0, 300));
                    console.log('[DEBUG] page_id:', m.page_id, '| url:', m.url, '| short_url:', m.short_url);
                    console.log('[DEBUG] type:', m.type, '| msg_type:', m.msg_type, '| media_type:', m.media_type);
                }
                const n = normalizeMessage(m);
                if (n && !messageIds.has(String(n.id))) {
                    messageIds.add(String(n.id));
                    allApiMessages.push(n);
                    added++;
                }
            }

            const firstMsg = msgList[0];
            const firstId = String(firstMsg?.id || firstMsg?.mid || '');

            // 时间截止
            const pageOldestTs = (typeof firstMsg?.time === 'number' && firstMsg.time > 0) ? firstMsg.time * 1000 : Date.now();
            if (stopTimestamp > 0 && pageOldestTs < stopTimestamp) {
                console.log(`[API] 到达截止时间，停止 (消息时间=${new Date(pageOldestTs).toLocaleString('zh-CN')})`);
                break;
            }

            if (pageNum % 10 === 0) {
                console.log(`[API] 第${pageNum + 1}页: +${added} 总=${allApiMessages.length}`);
            }

            if (!firstId || firstId === maxMid) {
                console.log('[API] 分页结束');
                break;
            }
            maxMid = firstId;
            pageNum++;

            await delay(300);
        } catch (e) {
            console.log(`[API] 请求失败: ${e.message}`);
            // 重试一次
            await delay(2000);
            try {
                const resp = await httpsGet(url);
                const data = JSON.parse(resp.body);
                const rawMsgs = data.messages || data.data?.messages || data.data || [];
                const msgList = Array.isArray(rawMsgs) ? rawMsgs : [];
                if (msgList.length === 0) break;
                let added = 0;
                for (const m of msgList) {
                    const n = normalizeMessage(m);
                    if (n && !messageIds.has(String(n.id))) {
                        messageIds.add(String(n.id));
                        allApiMessages.push(n);
                        added++;
                    }
                }
                const firstMsg = msgList[0];
                const firstId = String(firstMsg?.id || firstMsg?.mid || '');
                const pageOldestTs = (typeof firstMsg?.time === 'number' && firstMsg.time > 0) ? firstMsg.time * 1000 : Date.now();
                if (stopTimestamp > 0 && pageOldestTs < stopTimestamp) break;
                if (!firstId || firstId === maxMid) break;
                maxMid = firstId;
                pageNum++;
                await delay(300);
            } catch (e2) {
                console.log(`[API] 重试也失败: ${e2.message}`);
                break;
            }
        }
    }

    console.log(`API 分页获取完成: ${allApiMessages.length} 条消息`);

    // 合并 API 分页消息和已捕获的脚本层消息
    const scriptMessages = await page.evaluate(() => window.__ARCHIVER_STATE__?.getMessages() || []);
    console.log(`脚本层消息: ${scriptMessages.length} 条`);
    console.log(`网络层消息: ${networkMessages.length} 条`);

    // 合并去重：API 分页 + 脚本层 + 网络层
    const allMessages = new Map();
    for (const m of allApiMessages) {
        allMessages.set(String(m.id), m);
    }
    for (const m of scriptMessages) {
        if (!allMessages.has(String(m.id))) {
            allMessages.set(String(m.id), {
                id: m.id, from_uid: m.from_uid, user: m.user,
                timestamp: m.timestamp, time: m.time, date: m.date,
                content: m.content, type: m.type || 'text',
            });
        }
    }
    for (const m of networkMessages) {
        const key = String(m.id);
        if (!allMessages.has(key)) {
            const d = new Date(m.time);
            allMessages.set(key, {
                ...m,
                time: d.toLocaleString('zh-CN', { hour12: false }),
                date: d.toISOString().slice(0, 10),
            });
        }
    }

    const messages = [...allMessages.values()].sort((a, b) => a.timestamp - b.timestamp);
    console.log(`去重后总计: ${messages.length} 条消息`);

    if (messages.length > 0) {
        const groups = {};
        for (const msg of messages) {
            const date = msg.date || 'unknown';
            if (!groups[date]) groups[date] = [];
            groups[date].push(msg);
        }

        const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
        const filepath = path.join(groupDir, `weibo_chat_${timestamp}.json`);

        fs.writeFileSync(filepath, JSON.stringify({
            exportTime: new Date().toISOString(),
            totalMessages: messages.length,
            days: Object.keys(groups).length,
            messages: messages,
        }, null, 2));

        console.log(`已保存到: ${filepath}`);

        for (const [date, msgs] of Object.entries(groups)) {
            const dayFile = path.join(groupDir, `weibo_chat_${date}.json`);
            let existingMsgs = [];
            try {
                const existingData = JSON.parse(fs.readFileSync(dayFile, 'utf-8'));
                existingMsgs = Array.isArray(existingData) ? existingData : (existingData.messages || []);
            } catch (e) {
                // File doesn't exist or invalid, start fresh
            }
            // Merge and deduplicate by message ID
            const merged = [...existingMsgs, ...msgs];
            const deduped = [...new Map(merged.map(m => [m.id, m])).values()];
            deduped.sort((a, b) => a.timestamp - b.timestamp);
            fs.writeFileSync(dayFile, JSON.stringify(deduped, null, 2));
        }
        console.log(`已按天拆分保存 ${Object.keys(groups).length} 个文件`);

        // 保存归档状态：记录最新消息的时间戳，下次从这里继续
        const newestMsg = messages[messages.length - 1];
        const newState = {
            lastTimestamp: newestMsg.timestamp,
            lastRun: new Date().toISOString(),
            lastMessageCount: messages.length,
        };
        fs.writeFileSync(stateFile, JSON.stringify(newState, null, 2));
        console.log(`归档状态已保存 (截止: ${new Date(newestMsg.timestamp).toLocaleString('zh-CN')})`);
    }

    } // end for each group

    // 保存 Cookie
    const finalCookies = await page.cookies();
    fs.writeFileSync(CONFIG.cookieFile, JSON.stringify(finalCookies, null, 2));
    console.log(`Cookie 已更新 (${finalCookies.length} 个)`);
    console.log('下次运行将自动使用已保存的登录状态');

    // 关闭浏览器
    await browser.close();

    // 重新打开 Chrome
    console.log('重新打开 Chrome...');
    exec('open -a "Google Chrome"');

    console.log('完成！');
}

main().catch(err => {
    console.error('错误:', err);
    process.exit(1);
});
