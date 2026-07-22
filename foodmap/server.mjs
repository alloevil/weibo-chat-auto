// 美食地图的最小静态文件 + 数据 API server(纯 Node 内置 http,不引入新依赖)。
// 用法: node foodmap/server.mjs [--name 陈晓卿] [--port 3457]
import http from 'http';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');

function safeName(name) {
  return String(name).replace(/[^a-zA-Z0-9一-鿿]/g, '_');
}

function restaurantsPath(name) {
  return path.join(ROOT, 'foodmap', 'data', safeName(name), 'restaurants.json');
}

const args = process.argv.slice(2);
const opt = (n, d) => { const i = args.indexOf(`--${n}`); return i !== -1 ? args[i + 1] : d; };
const PORT = Number(opt('port')) || 3457;
const DEFAULT_NAME = opt('name') || '';

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://localhost');

  if (url.pathname === '/api/restaurants') {
    const name = url.searchParams.get('name') || DEFAULT_NAME;
    if (!name) { res.writeHead(400); res.end('缺少 name 参数'); return; }
    fs.readFile(restaurantsPath(name), 'utf-8', (err, data) => {
      if (err) { res.writeHead(404, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: '未找到该博主的数据,请先运行 extract-restaurants.mjs' })); return; }
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(data);
    });
    return;
  }

  if (url.pathname === '/' || url.pathname === '/index.html') {
    fs.readFile(path.join(__dirname, 'index.html'), 'utf-8', (err, data) => {
      if (err) { res.writeHead(500); res.end('index.html 读取失败'); return; }
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(data);
    });
    return;
  }

  res.writeHead(404);
  res.end('Not found');
});

server.listen(PORT, () => {
  console.log(`美食地图: http://localhost:${PORT}/${DEFAULT_NAME ? '' : '?name=<博主名>'}`);
  if (DEFAULT_NAME) console.log(`默认展示: ${DEFAULT_NAME}`);
});
