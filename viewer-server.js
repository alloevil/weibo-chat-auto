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

function loadMessages() {
    const files = fs.readdirSync(OUTPUT_DIR)
        .filter(f => /^weibo_chat_\d{4}-\d{2}-\d{2}\.json$/.test(f));

    const allMessages = [];
    for (const file of files) {
        try {
            const data = JSON.parse(fs.readFileSync(path.join(OUTPUT_DIR, file), 'utf-8'));
            const msgs = data.messages || data;
            if (Array.isArray(msgs)) allMessages.push(...msgs);
        } catch {}
    }

    // 按时间排序
    allMessages.sort((a, b) => a.timestamp - b.timestamp);
    return allMessages;
}

const server = http.createServer((req, res) => {
    const url = new URL(req.url, `http://localhost:${PORT}`);

    if (url.pathname === '/api/messages') {
        const messages = loadMessages();
        // 将 msget 图片 URL 重写为本地代理 URL
        for (const m of messages) {
            if (m.pics) {
                m.pics = m.pics.map(u => {
                    const fidMatch = u.match(/fid=(\d+)/);
                    return fidMatch ? `/api/image?fid=${fidMatch[1]}` : u;
                });
            }
        }
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ messages }));
        return;
    }

    // 图片代理：/api/image?fid=xxx
    if (url.pathname === '/api/image') {
        const fid = url.searchParams.get('fid');
        if (!fid) { res.writeHead(400); res.end('Missing fid'); return; }
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
            proxyRes.pipe(res);
        });
        req.on('error', () => { res.writeHead(500); res.end('Proxy error'); });
        req.setTimeout(15000, () => { req.destroy(); res.writeHead(504); res.end('Timeout'); });
        return;
    }

    // 静态页面
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
    console.log(`微博聊天查看器: http://localhost:${PORT}`);
});
