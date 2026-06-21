const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const { execFile, exec } = require('child_process');

const PORT = 3456;
const OUTPUT_DIR = path.join(__dirname, 'output');

process.on('uncaughtException', (err) => {
    console.error('[uncaughtException]', err.message);
});
process.on('unhandledRejection', (err) => {
    console.error('[unhandledRejection]', err);
});

function loadCookies() {
    const cookieFile = path.join(__dirname, 'cookies.json');
    try {
        const cookies = JSON.parse(fs.readFileSync(cookieFile, 'utf-8'));
        return cookies.map(c => `${c.name}=${c.value}`).join('; ');
    } catch { return ''; }
}

// Per-group message cache
const messageCaches = {};

function getGroupDir(groupName) {
    if (!groupName) return OUTPUT_DIR;
    const safe = groupName.replace(/[^a-zA-Z0-9一-鿿]/g, '_');
    return path.join(OUTPUT_DIR, safe);
}

function loadMessages(groupName = '') {
    const dir = getGroupDir(groupName);
    if (!fs.existsSync(dir)) return [];

    if (!messageCaches[groupName]) messageCaches[groupName] = {};
    const cache = messageCaches[groupName];

    const files = fs.readdirSync(dir)
        .filter(f => /^weibo_chat_\d{4}-\d{2}-\d{2}\.json$/.test(f));

    let changed = false;
    const currentMtimes = {};
    for (const f of files) {
        const mt = fs.statSync(path.join(dir, f)).mtimeMs;
        currentMtimes[f] = mt;
        if (!cache[f] || cache[f].mtime !== mt) changed = true;
    }
    if (!changed && Object.keys(cache).length === files.length) {
        // Return merged cache
        const all = [];
        for (const f of files) all.push(...cache[f].messages);
        all.sort((a, b) => a.timestamp - b.timestamp);
        return all;
    }

    const allMessages = [];
    for (const file of files) {
        const mt = currentMtimes[file];
        if (cache[file] && cache[file].mtime === mt) {
            allMessages.push(...cache[file].messages);
        } else {
            try {
                const data = JSON.parse(fs.readFileSync(path.join(dir, file), 'utf-8'));
                const msgs = data.messages || data;
                if (Array.isArray(msgs)) {
                    cache[file] = { mtime: mt, messages: msgs };
                    allMessages.push(...msgs);
                }
            } catch {}
        }
    }

    allMessages.sort((a, b) => a.timestamp - b.timestamp);
    return allMessages;
}

// Per-file cache for loadMessagesByDate
const fileCaches = {};

function loadMessagesByDate(groupName = '', date = '') {
    const dir = getGroupDir(groupName);
    if (!fs.existsSync(dir)) return [];

    const filePath = path.join(dir, `weibo_chat_${date}.json`);
    if (!fs.existsSync(filePath)) return [];

    try {
        const mt = fs.statSync(filePath).mtimeMs;
        const cacheKey = filePath;
        if (fileCaches[cacheKey] && fileCaches[cacheKey].mtime === mt) {
            return fileCaches[cacheKey].messages;
        }
        const data = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
        const msgs = data.messages || data;
        if (!Array.isArray(msgs)) return [];
        msgs.sort((a, b) => a.timestamp - b.timestamp);
        fileCaches[cacheKey] = { mtime: mt, messages: msgs };
        return msgs;
    } catch {
        return [];
    }
}

function rewriteImageUrls(messages) {
    for (const m of messages) {
        if (m.pics) {
            m.pics = m.pics.map(u => {
                // Skip if already rewritten
                if (u.startsWith('/api/image?fid=') || u.startsWith('/api/sinaimg?')) return u;
                const fidMatch = u.match(/fid=(\d+)/);
                return fidMatch ? `/api/image?fid=${fidMatch[1]}` : u;
            });
        }
        if (m.share && m.share.pics) {
            m.share.pics = m.share.pics.map(u => {
                // Skip if already rewritten
                if (u.startsWith('/api/sinaimg?')) return u;
                if (u.includes('sinaimg.cn')) {
                    return `/api/sinaimg?url=${encodeURIComponent(u)}`;
                }
                return u;
            });
        }
    }
}

const CACHE_DIR = path.join(__dirname, 'cache', 'images');
if (!fs.existsSync(CACHE_DIR)) fs.mkdirSync(CACHE_DIR, { recursive: true });

// Reusable LLM API caller (OpenAI-compatible)
function callLlmApi(messages, callback) {
    let aiConfig;
    try {
        aiConfig = JSON.parse(fs.readFileSync(path.join(__dirname, 'ai-config.json'), 'utf-8'));
    } catch { callback(null, 'AI 未配置'); return; }
    const reqBody = JSON.stringify({ model: aiConfig.model, messages });
    const apiUrl = new URL(aiConfig.baseUrl.replace(/\/$/, '') + '/chat/completions');
    const isHttps = apiUrl.protocol === 'https:';
    const httpModule = isHttps ? https : http;
    const options = {
        hostname: apiUrl.hostname,
        port: apiUrl.port || (isHttps ? 443 : 80),
        path: apiUrl.pathname + apiUrl.search,
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${aiConfig.apiKey}` },
        agent: false,
    };
    const llmReq = httpModule.request(options, (llmRes) => {
        const chunks = [];
        llmRes.on('data', chunk => chunks.push(chunk));
        llmRes.on('end', () => {
            const body = Buffer.concat(chunks).toString();
            try {
                const data = JSON.parse(body);
                if (data.error) { callback(null, data.error.message || JSON.stringify(data.error)); return; }
                callback(data.choices?.[0]?.message?.content || '');
            } catch (e) { callback(null, '解析失败: ' + e.message); }
        });
    });
    llmReq.on('error', (e) => callback(null, '请求失败: ' + e.message));
    llmReq.setTimeout(90000, () => { llmReq.destroy(); callback(null, '请求超时（90s）'); });
    llmReq.end(reqBody);
}

function serveImage(res, filePath, contentType) {
    const stat = fs.statSync(filePath);
    res.writeHead(200, {
        'Content-Type': contentType,
        'Cache-Control': 'public, max-age=86400',
        'Content-Length': stat.size,
    });
    fs.createReadStream(filePath).pipe(res);
}

const server = http.createServer((req, res) => {
    const url = new URL(req.url, `http://localhost:${PORT}`);

    // List available groups
    if (url.pathname === '/api/groups') {
        const groups = [];
        let lastArchived = 0;
        // Check root output dir (backward compat)
        if (fs.existsSync(OUTPUT_DIR)) {
            const rootFiles = fs.readdirSync(OUTPUT_DIR).filter(f => /^weibo_chat_\d{4}-\d{2}-\d{2}\.json$/.test(f));
            if (rootFiles.length > 0) {
                const latestMtime = rootFiles.reduce((max, f) => {
                    const mt = fs.statSync(path.join(OUTPUT_DIR, f)).mtimeMs;
                    return mt > max ? mt : max;
                }, 0);
                if (latestMtime > lastArchived) lastArchived = latestMtime;
                groups.push({ id: '', name: 'Default', count: rootFiles.length });
            }
            // Check subdirectories
            for (const entry of fs.readdirSync(OUTPUT_DIR, { withFileTypes: true })) {
                if (entry.isDirectory()) {
                    const subDir = path.join(OUTPUT_DIR, entry.name);
                    const files = fs.readdirSync(subDir).filter(f => /^weibo_chat_\d{4}-\d{2}-\d{2}\.json$/.test(f));
                    if (files.length > 0) {
                        const latestMtime = files.reduce((max, f) => {
                            const mt = fs.statSync(path.join(subDir, f)).mtimeMs;
                            return mt > max ? mt : max;
                        }, 0);
                        if (latestMtime > lastArchived) lastArchived = latestMtime;
                        groups.push({ id: entry.name, name: entry.name, count: files.length });
                    }
                }
            }
        }
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ groups, lastArchived }));
        return;
    }

    if (url.pathname === '/api/messages') {
        const group = url.searchParams.get('group') || '';
        const date = url.searchParams.get('date') || '';
        const messages = date ? loadMessagesByDate(group, date) : loadMessages(group);
        rewriteImageUrls(messages);
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ messages }));
        return;
    }

    // Get available dates and message counts
    if (url.pathname === '/api/dates') {
        const group = url.searchParams.get('group') || '';
        const dir = getGroupDir(group);
        const dates = {};
        if (fs.existsSync(dir)) {
            const files = fs.readdirSync(dir)
                .filter(f => /^weibo_chat_\d{4}-\d{2}-\d{2}\.json$/.test(f));
            for (const file of files) {
                const dateMatch = file.match(/weibo_chat_(\d{4}-\d{2}-\d{2})\.json/);
                if (dateMatch) {
                    const date = dateMatch[1];
                    try {
                        const data = JSON.parse(fs.readFileSync(path.join(dir, file), 'utf-8'));
                        const msgs = data.messages || data;
                        dates[date] = Array.isArray(msgs) ? msgs.length : 0;
                    } catch {
                        dates[date] = 0;
                    }
                }
            }
        }
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ dates }));
        return;
    }

    // Sync: trigger archiver
    if (url.pathname === '/api/sync' && req.method === 'POST') {
        // Invalidate all message caches
        for (const key in messageCaches) delete messageCaches[key];
        for (const key in fileCaches) delete fileCaches[key];
        execFile(process.execPath, [path.join(__dirname, 'auto-archive-simple.js')], {
            timeout: 600000,
            env: { ...process.env, PATH: process.env.PATH },
        }, (err, stdout, stderr) => {
            const out = (stdout || '') + (stderr || '');
            res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });

            if (err) {
                console.error('[sync] error:', stderr || err.message);
                res.end(JSON.stringify({ ok: false, error: stderr || err.message }));
                return;
            }

            // 归档器可能 exit 0 但实际失败（Cookie 过期、未找到群聊）
            if (out.includes('需要登录') || out.includes('扫描登录') || out.includes('登录失败')) {
                res.end(JSON.stringify({ ok: false, error: 'Cookie 已过期，请在终端运行 npm run save-cookies 重新登录' }));
                return;
            }

            // 统计成功归档的群数和被跳过的群
            const archived = (out.match(/已保存到:/g) || []).length;
            const skipped = (out.match(/跳过此群/g) || []).length;

            if (archived === 0 && skipped > 0) {
                res.end(JSON.stringify({ ok: false, error: `所有群同步失败（${skipped} 个群未找到，可能 Cookie 已过期）` }));
                return;
            }

            console.log(`[sync] done (archived=${archived}, skipped=${skipped})`);
            res.end(JSON.stringify({ ok: true, archived, skipped }));
        });
        return;
    }

    // Schedule: read/update launchd interval (macOS only)
    if (url.pathname === '/api/schedule') {
        if (process.platform !== 'darwin') {
            res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
            res.end(JSON.stringify({ supported: false }));
            return;
        }

        const PLIST_LABEL = 'com.allo.weibo-chat-archive';
        const PLIST_PATH = path.join(process.env.HOME, 'Library/LaunchAgents', `${PLIST_LABEL}.plist`);

        if (req.method === 'GET') {
            let interval = 0;
            let enabled = false;
            try {
                const content = fs.readFileSync(PLIST_PATH, 'utf-8');
                const match = content.match(/<key>StartInterval<\/key>\s*<integer>(\d+)<\/integer>/);
                if (match) interval = parseInt(match[1], 10);
                enabled = true;
            } catch {}
            // Check if actually loaded
            exec(`launchctl list ${PLIST_LABEL} 2>/dev/null`, (err) => {
                if (err) enabled = false;
                res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
                res.end(JSON.stringify({ supported: true, enabled, interval }));
            });
            return;
        }

        if (req.method === 'POST') {
            let body = '';
            req.on('data', chunk => { body += chunk; });
            req.on('end', () => {
                try {
                    const { interval } = JSON.parse(body);
                    if (typeof interval !== 'number' || interval < 0) {
                        res.writeHead(400, { 'Content-Type': 'application/json' });
                        res.end(JSON.stringify({ ok: false, error: 'Invalid interval' }));
                        return;
                    }

                    const unload = `launchctl unload "${PLIST_PATH}" 2>/dev/null`;

                    if (interval === 0) {
                        // Disable: just unload
                        exec(unload, () => {
                            res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
                            res.end(JSON.stringify({ ok: true, enabled: false, interval: 0 }));
                        });
                        return;
                    }

                    // Update plist with new interval
                    let content;
                    try { content = fs.readFileSync(PLIST_PATH, 'utf-8'); } catch {
                        res.writeHead(404, { 'Content-Type': 'application/json' });
                        res.end(JSON.stringify({ ok: false, error: 'Plist not found. Run setup.sh first.' }));
                        return;
                    }
                    content = content.replace(
                        /(<key>StartInterval<\/key>\s*<integer>)\d+(<\/integer>)/,
                        `$1${interval}$2`
                    );
                    fs.writeFileSync(PLIST_PATH, content, 'utf-8');

                    // Reload
                    exec(`${unload}; launchctl load "${PLIST_PATH}"`, (err) => {
                        if (err) {
                            res.writeHead(500, { 'Content-Type': 'application/json' });
                            res.end(JSON.stringify({ ok: false, error: err.message }));
                            return;
                        }
                        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
                        res.end(JSON.stringify({ ok: true, enabled: true, interval }));
                    });
                } catch (e) {
                    res.writeHead(400, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ ok: false, error: e.message }));
                }
            });
            return;
        }
    }

    // Image proxy: /api/image?fid=xxx (with disk cache)
    if (url.pathname === '/api/image') {
        const fid = url.searchParams.get('fid');
        if (!fid) { res.writeHead(400); res.end('Missing fid'); return; }

        const cacheFile = path.join(CACHE_DIR, `${fid}.jpg`);
        if (fs.existsSync(cacheFile)) {
            serveImage(res, cacheFile, 'image/jpeg');
            return;
        }

        const imageUrl = `https://upload.api.weibo.com/2/mss/msget?source=209678993&fid=${fid}`;
        const cookieHeader = loadCookies();
        const proxyReq = https.get(imageUrl, {
            headers: {
                'Cookie': cookieHeader,
                'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36',
                'Referer': 'https://api.weibo.com/chat',
                'X-Requested-With': 'XMLHttpRequest',
            },
        }, (proxyRes) => {
            if (proxyRes.statusCode !== 200) {
                res.writeHead(proxyRes.statusCode);
                res.end('Image fetch failed');
                return;
            }
            const ct = proxyRes.headers['content-type'] || 'image/jpeg';
            res.writeHead(200, {
                'Content-Type': ct,
                'Cache-Control': 'public, max-age=86400',
            });
            const chunks = [];
            proxyRes.on('data', chunk => chunks.push(chunk));
            proxyRes.on('end', () => {
                const buffer = Buffer.concat(chunks);
                fs.writeFile(cacheFile, buffer, () => {});
                res.end(buffer);
            });
        });
        proxyReq.on('error', () => { if (!res.headersSent) { res.writeHead(500); res.end('Proxy error'); } });
        proxyReq.setTimeout(15000, () => { proxyReq.destroy(); if (!res.headersSent) { res.writeHead(504); res.end('Timeout'); } });
        return;
    }

    // sinaimg CDN image proxy
    if (url.pathname === '/api/sinaimg') {
        const imgUrl = url.searchParams.get('url');
        if (!imgUrl || !/^https:\/\/wx[0-9]*\.sinaimg\.cn\//.test(imgUrl)) { res.writeHead(403); res.end('Forbidden'); return; }
        const proxyReq = https.get(imgUrl, {
            headers: {
                'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36',
                'Referer': 'https://weibo.com/',
            },
        }, (proxyRes) => {
            if (proxyRes.statusCode !== 200) {
                res.writeHead(proxyRes.statusCode);
                res.end('Image fetch failed');
                return;
            }
            const ct = proxyRes.headers['content-type'] || 'image/jpeg';
            res.writeHead(200, {
                'Content-Type': ct,
                'Cache-Control': 'public, max-age=86400',
            });
            proxyRes.pipe(res);
        });
        proxyReq.on('error', () => { if (!res.headersSent) { res.writeHead(500); res.end('Proxy error'); } });
        proxyReq.setTimeout(15000, () => { proxyReq.destroy(); if (!res.headersSent) { res.writeHead(504); res.end('Timeout'); } });
        return;
    }

    // AI config: read/write ai-config.json
    if (url.pathname === '/api/ai-config') {
        const AI_CONFIG_PATH = path.join(__dirname, 'ai-config.json');

        if (req.method === 'GET') {
            try {
                const cfg = JSON.parse(fs.readFileSync(AI_CONFIG_PATH, 'utf-8'));
                const masked = { ...cfg };
                if (masked.apiKey) {
                    const k = masked.apiKey;
                    masked.apiKey = k.length > 8 ? k.slice(0, 3) + '***' + k.slice(-4) : '***';
                }
                res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
                res.end(JSON.stringify({ ok: true, config: masked }));
            } catch {
                res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
                res.end(JSON.stringify({ ok: true, config: null }));
            }
            return;
        }

        if (req.method === 'POST') {
            let body = '';
            req.on('data', chunk => { body += chunk; });
            req.on('end', () => {
                try {
                    const { baseUrl, apiKey, model, vision } = JSON.parse(body);
                    let existingKey = '';
                    try { existingKey = JSON.parse(fs.readFileSync(AI_CONFIG_PATH, 'utf-8')).apiKey || ''; } catch {}
                    const cfg = { baseUrl: baseUrl || '', apiKey: apiKey || existingKey, model: model || '', vision: !!vision };
                    fs.writeFileSync(AI_CONFIG_PATH, JSON.stringify(cfg, null, 2), 'utf-8');
                    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
                    res.end(JSON.stringify({ ok: true }));
                } catch (e) {
                    res.writeHead(400, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ ok: false, error: e.message }));
                }
            });
            return;
        }
    }

    // AI summary: generate or return cached
    if (url.pathname === '/api/summary' && req.method === 'GET') {
        const group = url.searchParams.get('group') || '';
        const date = url.searchParams.get('date') || '';
        if (!date) { res.writeHead(400); res.end(JSON.stringify({ ok: false, error: 'Missing date' })); return; }

        const AI_CONFIG_PATH = path.join(__dirname, 'ai-config.json');
        let aiConfig;
        try { aiConfig = JSON.parse(fs.readFileSync(AI_CONFIG_PATH, 'utf-8')); } catch {
            res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
            res.end(JSON.stringify({ ok: false, error: '未配置 AI，请先在设置中配置' }));
            return;
        }
        if (!aiConfig.baseUrl || !aiConfig.apiKey || !aiConfig.model) {
            res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
            res.end(JSON.stringify({ ok: false, error: 'AI 配置不完整' }));
            return;
        }

        // Check cache
        const dir = getGroupDir(group);
        const cacheFile = path.join(dir, `summary_${date}.json`);
        if (fs.existsSync(cacheFile)) {
            try {
                const cached = JSON.parse(fs.readFileSync(cacheFile, 'utf-8'));
                res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
                res.end(JSON.stringify({ ok: true, summary: cached.summary, cached: true }));
                return;
            } catch {}
        }

        // Load messages for the date
        const messages = loadMessagesByDate(group, date);
        if (!messages.length) {
            res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
            res.end(JSON.stringify({ ok: false, error: '当天无消息数据' }));
            return;
        }

        // Format messages for LLM — track pic positions for vision enrichment
        let formatted = messages.map((m) => {
            const t = m.time ? m.time.split(' ')[1]?.slice(0, 5) : '';
            let text = m.content || '';
            if (m.share) text += ` [分享: ${m.share.title || m.share.text || m.share.url}]`;
            if (m.pics && m.pics.length) text += ` [图片x${m.pics.length}]`;
            return `[${t}] ${m.user}: ${text}`;
        }).join('\n');

        const systemPrompt = `你是一个群聊记录分析助手。请对以下微博群聊记录进行话题提炼和总结。

核心要求：
1. **准确性第一**：只总结消息中明确出现的内容，不要推测或补充未提及的信息
2. **话题识别**：将消息按讨论话题聚类，即使话题在时间上是交叉的也要分开归纳
3. **保留关键观点**：记录谁说了什么关键观点，用「用户名：观点」格式标注
4. **忽略噪声**：跳过纯表情回复、红包提示、系统消息、无实质内容的附和

重点标识（如果当天出现以下内容，请用标签醒目标出）：
- 💰 **财经/投资**：股票、基金、行情分析、投资决策相关讨论
- 🎁 **好物推荐**：工具、App、书籍、硬件等推荐，标注推荐人和理由
- 👤 **tombkeeper 发言**：此用户的观点和分享单独标注（无论在哪个话题中）

输出格式：
## 话题一：[话题标题] [标签]
[2-4句话概括讨论内容，标注关键发言人和核心观点]

## 话题二：[话题标题] [标签]
...

## 值得关注的链接/分享
- [标题或描述](链接) — 分享者：xxx
（没有则省略此节）

注意：
- 话题标题要具体，不要用"日常闲聊"这种模糊表述
- [标签] 为 💰/🎁/👤 之一或多个，不符合任何重点类别则不加标签
- 如果某条消息是在引用/回复另一条，注意还原对话上下文
- 不确定的内容宁可不写，不要编造`;

        // Helper: call OpenAI-compatible API
        function callApi(llmMessages, onSuccess, onError) {
            const reqBody = JSON.stringify({ model: aiConfig.model, messages: llmMessages });
            const apiUrl = new URL(aiConfig.baseUrl.replace(/\/$/, '') + '/chat/completions');
            const isHttps = apiUrl.protocol === 'https:';
            const httpModule = isHttps ? https : http;
            const options = {
                hostname: apiUrl.hostname,
                port: apiUrl.port || (isHttps ? 443 : 80),
                path: apiUrl.pathname + apiUrl.search,
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${aiConfig.apiKey}`,
                },
                agent: false,
            };
            const llmReq = httpModule.request(options, (llmRes) => {
                const chunks = [];
                llmRes.on('data', chunk => chunks.push(chunk));
                llmRes.on('end', () => {
                    const body = Buffer.concat(chunks).toString();
                    try {
                        const data = JSON.parse(body);
                        if (data.error) { onError(data.error.message || JSON.stringify(data.error)); return; }
                        onSuccess(data.choices?.[0]?.message?.content || '');
                    } catch (e) { onError('LLM 返回解析失败: ' + e.message); }
                });
            });
            llmReq.on('error', (e) => onError('LLM 请求失败: ' + e.message));
            llmReq.setTimeout(90000, () => { llmReq.destroy(); onError('LLM 请求超时（90s）'); });
            llmReq.end(reqBody);
        }

        // Final summary call
        function callSummary() {
            const llmMessages = [
                { role: 'system', content: systemPrompt },
                { role: 'user', content: `以下是 ${date} 的群聊记录（${messages.length} 条消息）：\n\n${formatted}` }
            ];
            callApi(llmMessages, (summary) => {
                try { fs.writeFileSync(cacheFile, JSON.stringify({ summary, date, generatedAt: new Date().toISOString() }), 'utf-8'); } catch {}
                res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
                res.end(JSON.stringify({ ok: true, summary, cached: false }));
            }, (err) => {
                if (!res.headersSent) {
                    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
                    res.end(JSON.stringify({ ok: false, error: err }));
                }
            });
        }

        // Vision two-step: describe images first, enrich text, then summarize
        if (aiConfig.vision) {
            // Collect images with their message context
            const imageItems = [];
            for (const m of messages) {
                if (m.pics && imageItems.length < 5) {
                    for (const pic of m.pics) {
                        if (imageItems.length >= 5) break;
                        const t = m.time ? m.time.split(' ')[1]?.slice(0, 5) : '';
                        imageItems.push({ url: pic, user: m.user, time: t, context: (m.content || '').slice(0, 50) });
                    }
                }
            }
            if (imageItems.length > 0) {
                const cookieHeader = loadCookies();
                const fetchImage = (picUrl) => new Promise((resolve) => {
                    let imgUrl = picUrl;
                    let fid = null;
                    if (picUrl.startsWith('/api/image?fid=')) {
                        fid = picUrl.split('fid=')[1];
                        imgUrl = `https://upload.api.weibo.com/2/mss/msget?source=209678993&fid=${fid}`;
                    } else {
                        const fidMatch = picUrl.match(/fid=(\d+)/);
                        if (fidMatch) fid = fidMatch[1];
                    }
                    const imgCacheFile = fid ? path.join(CACHE_DIR, `${fid}.jpg`) : path.join(CACHE_DIR, picUrl.replace(/[^a-zA-Z0-9]/g, '_').slice(-40) + '.jpg');
                    if (fs.existsSync(imgCacheFile)) {
                        const stat = fs.statSync(imgCacheFile);
                        if (stat.size > 3.5 * 1024 * 1024) { resolve(null); return; }
                        const imgBuf = fs.readFileSync(imgCacheFile);
                        const isPng = imgBuf[0] === 0x89 && imgBuf[1] === 0x50;
                        if (imgBuf[0] !== 0xFF && !isPng) { resolve(null); return; }
                        const mime = isPng ? 'image/png' : 'image/jpeg';
                        resolve(`data:${mime};base64,` + imgBuf.toString('base64'));
                        return;
                    }
                    https.get(imgUrl, { headers: { 'Cookie': cookieHeader, 'Referer': 'https://api.weibo.com/chat' } }, (imgRes) => {
                        if (imgRes.statusCode !== 200) { resolve(null); return; }
                        const chunks = [];
                        imgRes.on('data', c => chunks.push(c));
                        imgRes.on('end', () => {
                            const buf = Buffer.concat(chunks);
                            if (buf.length > 3.5 * 1024 * 1024) { resolve(null); return; }
                            const isJpeg = buf[0] === 0xFF && buf[1] === 0xD8 && buf[2] === 0xFF;
                            const isPng = buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4E && buf[3] === 0x47;
                            if (!isJpeg && !isPng) { resolve(null); return; }
                            try { fs.writeFileSync(imgCacheFile, buf); } catch {}
                            const mime = isPng ? 'image/png' : 'image/jpeg';
                            resolve(`data:${mime};base64,` + buf.toString('base64'));
                        });
                    }).on('error', () => resolve(null));
                });

                // Step 1: Download all images
                Promise.all(imageItems.map(item => fetchImage(item.url))).then((base64Results) => {
                    // Pair images with their context
                    const validImages = [];
                    for (let i = 0; i < base64Results.length; i++) {
                        if (base64Results[i]) {
                            validImages.push({ base64: base64Results[i], ...imageItems[i] });
                        }
                    }
                    if (!validImages.length) { callSummary(); return; }

                    // Step 2: Describe each image via vision API
                    let described = 0;
                    const descriptions = new Array(validImages.length);
                    validImages.forEach((img, idx) => {
                        const descMessages = [
                            { role: 'user', content: [
                                { type: 'text', text: `这是群聊中 ${img.user} 在 ${img.time} 发的图片${img.context ? '，消息文字：' + img.context : ''}。请用一句话简要描述图片内容（20-50字），只描述你看到的，不要猜测。` },
                                { type: 'image_url', image_url: { url: img.base64 } }
                            ] }
                        ];
                        callApi(descMessages, (desc) => {
                            descriptions[idx] = desc.replace(/\n/g, ' ').slice(0, 100);
                            described++;
                            if (described === validImages.length) {
                                // Step 3: Enrich formatted text with descriptions
                                for (let i = 0; i < validImages.length; i++) {
                                    const img = validImages[i];
                                    const placeholder = `[${img.time}] ${img.user}:`;
                                    const line = formatted.split('\n').find(l => l.includes(placeholder) && l.includes('[图片'));
                                    if (line) {
                                        const enriched = line.replace(/\[图片x\d+\]/, `[图片: ${descriptions[i]}]`);
                                        formatted = formatted.replace(line, enriched);
                                    }
                                }
                                callSummary();
                            }
                        }, (err) => {
                            descriptions[idx] = null;
                            described++;
                            if (described === validImages.length) {
                                for (let i = 0; i < validImages.length; i++) {
                                    if (!descriptions[i]) continue;
                                    const img = validImages[i];
                                    const placeholder = `[${img.time}] ${img.user}:`;
                                    const line = formatted.split('\n').find(l => l.includes(placeholder) && l.includes('[图片'));
                                    if (line) {
                                        const enriched = line.replace(/\[图片x\d+\]/, `[图片: ${descriptions[i]}]`);
                                        formatted = formatted.replace(line, enriched);
                                    }
                                }
                                callSummary();
                            }
                        });
                    });
                });
            } else {
                callSummary();
            }
        } else {
            callSummary();
        }
        return;
    }

    // --- Q&A Endpoint (Agentic RAG) ---
    if (url.pathname === '/api/qa' && req.method === 'POST') {
        let body = '';
        req.on('data', c => body += c);
        req.on('end', () => {
            const reply = (data) => { res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' }); res.end(JSON.stringify(data)); };
            let params;
            try { params = JSON.parse(body); } catch { reply({ ok: false, error: '参数解析失败' }); return; }
            const { group, question } = params;
            if (!group || !question) { reply({ ok: false, error: '缺少 group 或 question' }); return; }

            // Load all messages for this group
            const allMessages = loadMessages(group);
            if (!allMessages.length) { reply({ ok: false, error: '该群无消息数据' }); return; }

            // Step 1: LLM extracts search keywords AND date range from the question
            const today = new Date().toISOString().split('T')[0];
            const extractPrompt = [
                { role: 'system', content: `你是一个搜索查询解析器。今天是 ${today}。根据用户的问题，提取搜索关键词和时间范围。

输出严格JSON格式（不要输出其他内容）：
{"keywords": ["关键词1", "关键词2", ...], "person": "人名或null", "dateFrom": "YYYY-MM-DD或null", "dateTo": "YYYY-MM-DD或null"}

规则：
- keywords: 3-5个最相关的搜索关键词（排除人名和时间词）
- person: 如果问题针对某个人（如"xx说了什么"），提取人名，否则null
- dateFrom/dateTo: 将时间表述转为绝对日期：
  - "昨天" → 昨天日期到昨天日期
  - "前天" → 前天日期到前天日期
  - "上周" → 上周一到上周日
  - "最近" / "最近几天" → 7天前到今天
  - "这周" → 本周一到今天
  - "上个月" → 上月1号到上月最后一天
  - 无时间表述 → null
- 不要把"昨天""最近""上周"等时间词放入keywords` },
                { role: 'user', content: question }
            ];
            callLlmApi(extractPrompt, (extraction, err) => {
                if (err) { reply({ ok: false, error: '查询解析失败: ' + err }); return; }

                // Parse LLM output as JSON
                let keywordList, dateFrom, dateTo, person;
                try {
                    const parsed = JSON.parse(extraction.replace(/```json?\s*|\s*```/g, '').trim());
                    keywordList = parsed.keywords || [];
                    dateFrom = parsed.dateFrom || null;
                    dateTo = parsed.dateTo || null;
                    person = parsed.person || null;
                } catch {
                    // Fallback: treat entire output as comma-separated keywords
                    keywordList = extraction.split(/[,，、\s]+/).filter(k => k.length > 0);
                    dateFrom = null;
                    dateTo = null;
                    person = null;
                }

                // Filter messages by date range if specified
                let messages = allMessages;
                if (dateFrom || dateTo) {
                    messages = allMessages.filter(m => {
                        const d = (m.time || '').split(' ')[0].replace(/\//g, '-');
                        if (!d) return false;
                        if (dateFrom && d < dateFrom) return false;
                        if (dateTo && d > dateTo) return false;
                        return true;
                    });
                    if (!messages.length) {
                        reply({ ok: true, answer: `在 ${dateFrom || '?'} 至 ${dateTo || '?'} 期间未找到聊天记录。`, sources: [], keywords: keywordList });
                        return;
                    }
                }

                // Step 2: Search messages using keywords + person filter
                const scored = [];
                for (let i = 0; i < messages.length; i++) {
                    const m = messages[i];
                    const text = (m.user || '') + ' ' + (m.content || '') + ' ' + (m.share?.title || '');
                    let score = 0;
                    // Person match gives high base score
                    if (person && (m.user || '').toLowerCase().includes(person.toLowerCase())) {
                        score += 3;
                    }
                    for (const kw of keywordList) {
                        if (text.toLowerCase().includes(kw.toLowerCase())) score++;
                    }
                    if (score > 0) scored.push({ idx: i, score });
                }

                if (!scored.length && (dateFrom || dateTo)) {
                    // Date filtered but no hits — show messages in range as context
                    const sample = messages.slice(-50);
                    const contextText = sample.map(m => {
                        const t = m.time ? m.time.split(' ')[1]?.slice(0, 5) : '';
                        const date = m.time ? m.time.split(' ')[0] : '';
                        let text = m.content || '';
                        if (m.share) text += ` [分享: ${m.share.title || m.share.url || ''}]`;
                        return `[${date} ${t}] ${m.user}: ${text}`;
                    }).join('\n');
                    const answerPrompt = [
                        { role: 'system', content: `你是一个群聊记录问答助手。根据提供的聊天记录回答用户问题。只基于提供的记录回答，不要编造。如果记录中没有相关信息，明确说明。用简洁的中文回答。` },
                        { role: 'user', content: `问题：${question}\n\n以下是 ${dateFrom || '?'} 至 ${dateTo || '?'} 期间的群聊记录：\n\n${contextText.slice(0, 8000)}` }
                    ];
                    callLlmApi(answerPrompt, (answer, ansErr) => {
                        if (ansErr) { reply({ ok: false, error: '回答生成失败: ' + ansErr }); return; }
                        reply({ ok: true, answer, sources: [{ date: dateFrom || dateTo || '', preview: `${messages.length} 条消息` }], keywords: keywordList, dateRange: { from: dateFrom, to: dateTo } });
                    });
                    return;
                }

                if (!scored.length) {
                    reply({ ok: true, answer: '未找到与该问题相关的聊天记录。请尝试换一种问法或使用更具体的关键词。', sources: [], keywords: keywordList });
                    return;
                }

                // Sort by score, take top hits
                scored.sort((a, b) => b.score - a.score);
                const topHits = scored.slice(0, 20);

                // Step 3: Expand context — for each hit, include ±5 surrounding messages, deduplicate
                const segments = new Set();
                const contextChunks = [];
                for (const hit of topHits) {
                    const start = Math.max(0, hit.idx - 5);
                    const end = Math.min(messages.length, hit.idx + 6);
                    const segKey = `${start}-${end}`;
                    if (segments.has(segKey)) continue;
                    let skip = false;
                    for (const existing of segments) {
                        const [es, ee] = existing.split('-').map(Number);
                        if (start >= es && end <= ee) { skip = true; break; }
                    }
                    if (skip) continue;
                    segments.add(segKey);
                    const chunk = messages.slice(start, end).map(m => {
                        const t = m.time ? m.time.split(' ')[1]?.slice(0, 5) : '';
                        const date = m.time ? m.time.split(' ')[0] : '';
                        let text = m.content || '';
                        if (m.share) text += ` [分享: ${m.share.title || m.share.url || ''}]`;
                        if (m.pics?.length) text += ` [图片x${m.pics.length}]`;
                        return `[${date} ${t}] ${m.user}: ${text}`;
                    }).join('\n');
                    const firstMsg = messages[start];
                    contextChunks.push({ text: chunk, date: (firstMsg.time?.split(' ')[0] || '').replace(/\//g, '-'), score: hit.score });
                }

                // Limit total context to ~8000 chars
                let totalLen = 0;
                const finalChunks = [];
                for (const c of contextChunks) {
                    if (totalLen + c.text.length > 8000) break;
                    finalChunks.push(c);
                    totalLen += c.text.length;
                }

                // Step 4: LLM generates answer with citations
                const contextText = finalChunks.map((c, i) => `--- 片段 ${i + 1}（${c.date}）---\n${c.text}`).join('\n\n');
                const answerPrompt = [
                    { role: 'system', content: `你是一个群聊记录问答助手。根据提供的聊天记录片段回答用户问题。

要求：
1. 只基于提供的聊天记录回答，不要编造
2. 引用具体发言人和日期
3. 如果记录中没有足够信息回答问题，明确说明
4. 用简洁的中文回答，保持准确` },
                    { role: 'user', content: `问题：${question}\n\n以下是相关的群聊记录片段：\n\n${contextText}` }
                ];
                callLlmApi(answerPrompt, (answer, ansErr) => {
                    if (ansErr) { reply({ ok: false, error: '回答生成失败: ' + ansErr }); return; }
                    const sources = finalChunks.map(c => ({ date: c.date, preview: c.text.split('\n').slice(0, 3).join(' | ').slice(0, 100) }));
                    reply({ ok: true, answer, sources, keywords: keywordList, dateRange: (dateFrom || dateTo) ? { from: dateFrom, to: dateTo } : undefined });
                });
            });
        });
        return;
    }

    // Static page
    if (url.pathname === '/' || url.pathname === '/index.html') {
        const html = fs.readFileSync(path.join(__dirname, 'viewer.html'), 'utf-8');
        res.writeHead(200, {
            'Content-Type': 'text/html; charset=utf-8',
            'Cache-Control': 'no-cache, no-store, must-revalidate',
        });
        res.end(html);
        return;
    }

    // 静态 JS 模块（lib/*.js）
    if (/^\/lib\/[\w-]+\.js$/.test(url.pathname)) {
        const filePath = path.join(__dirname, url.pathname);
        if (fs.existsSync(filePath)) {
            res.writeHead(200, {
                'Content-Type': 'application/javascript; charset=utf-8',
                'Cache-Control': 'no-cache, no-store, must-revalidate',
            });
            res.end(fs.readFileSync(filePath, 'utf-8'));
            return;
        }
    }

    res.writeHead(404);
    res.end('Not Found');
});

server.listen(PORT, () => {
    const url = `http://localhost:${PORT}`;
    console.log(`Weibo Group Chat Viewer: ${url}`);
    // 自动打开浏览器（设 NO_OPEN=1 可禁用）
    if (!process.env.NO_OPEN) {
        const opener = process.platform === 'darwin' ? 'open'
            : process.platform === 'win32' ? 'start' : 'xdg-open';
        require('child_process').exec(`${opener} ${url}`, () => {});
    }
});
