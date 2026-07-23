// 本地起一个最小静态文件 server(纯 Node 内置 http,不引入新依赖),行为与
// GitHub Pages 完全一致——index.html 用相对路径 fetch data/<name>/restaurants.json,
// 本地开发和线上静态托管走的是同一套代码,不需要额外的 /api 层。
// 用法: node server.mjs [--port 3457]
import http from 'http';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = __dirname;

const MIME = { '.html': 'text/html; charset=utf-8', '.json': 'application/json; charset=utf-8', '.js': 'text/javascript', '.png': 'image/png' };

const args = process.argv.slice(2);
const opt = (n, d) => { const i = args.indexOf(`--${n}`); return i !== -1 ? args[i + 1] : d; };
const PORT = Number(opt('port')) || 3457;

const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://localhost');
    let reqPath = decodeURIComponent(url.pathname);
    if (reqPath === '/') reqPath = '/index.html';

    const filePath = path.normalize(path.join(ROOT, reqPath));
    if (!filePath.startsWith(ROOT)) { res.writeHead(403); res.end('Forbidden'); return; } // 防目录穿越

    fs.readFile(filePath, (err, data) => {
        if (err) { res.writeHead(404); res.end('Not found'); return; }
        const ext = path.extname(filePath);
        res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream' });
        res.end(data);
    });
});

server.listen(PORT, () => {
    console.log(`美食地图: http://localhost:${PORT}/`);
    console.log(`(默认展示示例数据"陈晓卿",用 ?name=<博主名> 切换)`);
});
