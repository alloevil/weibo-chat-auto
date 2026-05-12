const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');

const PORT = 3456;
const OUTPUT_DIR = path.join(__dirname, 'output');

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

    if (!messageCaches[groupName]) messageCaches[groupName] = { cache: null, mtimes: {} };
    const entry = messageCaches[groupName];

    const files = fs.readdirSync(dir)
        .filter(f => /^weibo_chat_\d{4}-\d{2}-\d{2}\.json$/.test(f));

    const currentMtimes = {};
    let changed = files.length !== Object.keys(entry.mtimes).length;
    for (const f of files) {
        const mt = fs.statSync(path.join(dir, f)).mtimeMs;
        currentMtimes[f] = mt;
        if (entry.mtimes[f] !== mt) changed = true;
    }

    if (!changed && entry.cache) return entry.cache;

    const allMessages = [];
    for (const file of files) {
        try {
            const data = JSON.parse(fs.readFileSync(path.join(dir, file), 'utf-8'));
            const msgs = data.messages || data;
            if (Array.isArray(msgs)) allMessages.push(...msgs);
        } catch {}
    }

    allMessages.sort((a, b) => a.timestamp - b.timestamp);
    entry.cache = allMessages;
    entry.mtimes = currentMtimes;
    return allMessages;
}

function loadMessagesByDate(groupName = '', date = '') {
    const dir = getGroupDir(groupName);
    if (!fs.existsSync(dir)) return [];

    const file = path.join(dir, `weibo_chat_${date}.json`);
    if (!fs.existsSync(file)) return [];

    try {
        const data = JSON.parse(fs.readFileSync(file, 'utf-8'));
        const msgs = data.messages || data;
        if (!Array.isArray(msgs)) return [];
        msgs.sort((a, b) => a.timestamp - b.timestamp);
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
    const req = https.get(imageUrl, {
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
            // Cache to disk
            const chunks = [];
            proxyRes.on('data', chunk => chunks.push(chunk));
            proxyRes.on('end', () => {
                const buffer = Buffer.concat(chunks);
                fs.writeFile(cacheFile, buffer, () => {});
                res.end(buffer);
            });
        });
        req.on('error', () => { res.writeHead(500); res.end('Proxy error'); });
        req.setTimeout(15000, () => { req.destroy(); res.writeHead(504); res.end('Timeout'); });
        return;
    }

    // sinaimg CDN image proxy
    if (url.pathname === '/api/sinaimg') {
        const imgUrl = url.searchParams.get('url');
        if (!imgUrl || !/^https:\/\/wx[0-9]*\.sinaimg\.cn\//.test(imgUrl)) { res.writeHead(403); res.end('Forbidden'); return; }
        const req = https.get(imgUrl, {
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
        req.on('error', () => { res.writeHead(500); res.end('Proxy error'); });
        req.setTimeout(15000, () => { req.destroy(); res.writeHead(504); res.end('Timeout'); });
        return;
    }

    // Static page
    if (url.pathname === '/' || url.pathname === '/index.html') {
        const html = fs.readFileSync(path.join(__dirname, 'viewer.html'), 'utf-8');
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(html);
        return;
    }

    res.writeHead(404);
    res.end('Not Found');
});

server.listen(PORT, () => {
    console.log(`Weibo Group Chat Viewer: http://localhost:${PORT}`);
});
