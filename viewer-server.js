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
