// 抓取指定微博用户个人主页的全部原创动态(https://weibo.com/ajax/statuses/mymblog)。
// 登录态是 weibo.com 主站的独立会话(见 weibo-cookies.mjs 顶部说明,与群聊
// 归档的 cookies.json 完全隔离),运行前先 `node foodmap/login.mjs` 扫码。
//
// 用法:
//   node foodmap/fetch-posts.mjs --uid 1647375747 --name 陈晓卿 --probe
//   node foodmap/fetch-posts.mjs --uid 1647375747 --name 陈晓卿 --mode full
//   node foodmap/fetch-posts.mjs --uid 1647375747 --name 陈晓卿          # 增量:遇到已存过的 id 即停
//
// 分页发现(实地探测,见 normalize.mjs 顶部注释):page 从 1 递增,每页
// ~23-25 条,直到返回空列表。不依赖 API 返回的 since_id 字符串(带非数字
// 后缀,不是简单游标),完全靠本地已存 id 判断增量边界。
import fs from 'fs';
import path from 'path';
import https from 'https';
import { fileURLToPath } from 'url';
import { normalizePost, mergePosts } from './normalize.mjs';
import * as weiboCookies from './weibo-cookies.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');

const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

function delay(ms) {
  return new Promise(r => setTimeout(r, ms));
}

function httpsGetJson(url, uid) {
  return new Promise((resolve, reject) => {
    https.get(url, {
      headers: {
        Cookie: weiboCookies.cookieHeader(),
        'User-Agent': UA,
        Referer: `https://weibo.com/u/${uid}`,
        Accept: 'application/json, text/plain, */*',
        'X-Requested-With': 'XMLHttpRequest',
      },
    }, (res) => {
      let body = '';
      res.on('data', c => body += c);
      res.on('end', () => {
        if (res.statusCode !== 200) { reject(new Error(`HTTP ${res.statusCode}`)); return; }
        try { resolve(JSON.parse(body)); } catch (e) { reject(new Error(`JSON 解析失败: ${e.message}`)); }
      });
    }).on('error', reject);
  });
}

async function fetchPageWithRetry(uid, page, { maxRetries = 2 } = {}) {
  const url = `https://weibo.com/ajax/statuses/mymblog?uid=${uid}&page=${page}&feature=0`;
  let lastErr;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      const data = await httpsGetJson(url, uid);
      if (data.ok === -100) throw new Error('未登录(ok:-100),请先运行 node foodmap/login.mjs');
      if (!data.ok || !data.data) throw new Error(`接口返回 ok=${data.ok}`);
      return data.data;
    } catch (e) {
      lastErr = e;
      if (e.message.includes('未登录')) throw e; // 未登录不必重试
      if (attempt < maxRetries) await delay(3000 * (attempt + 1));
    }
  }
  throw lastErr;
}

function dataDir(name) {
  const safe = name.replace(/[^a-zA-Z0-9一-鿿]/g, '_');
  return path.join(ROOT, 'foodmap', 'data', safe);
}

function loadExisting(dir) {
  const file = path.join(dir, 'posts_raw.json');
  try {
    return JSON.parse(fs.readFileSync(file, 'utf-8'));
  } catch {
    return [];
  }
}

function savePosts(dir, posts) {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'posts_raw.json'), JSON.stringify(posts, null, 2));
}

// --- 位置字段人工巡检:打印每条动态里疑似位置相关的字段,供人工确认结构 ---
function surveyLocationFields(rawPosts) {
  console.log(`\n=== 位置字段巡检(${rawPosts.length} 条样本) ===`);
  let geoCount = 0, checkinCount = 0;
  for (const raw of rawPosts) {
    const hasGeo = !!raw.geo && raw.geo !== '';
    const checkin = Array.isArray(raw.url_struct) && raw.url_struct.find(u => u?.object_type === 'place');
    if (hasGeo) geoCount++;
    if (checkin) checkinCount++;
    if (hasGeo || checkin) {
      console.log(`  id=${raw.id} geo=${hasGeo ? JSON.stringify(raw.geo.coordinates) : '无'} checkin=${checkin?.url_title || '无'} region_name="${raw.region_name || ''}"`);
      console.log(`    text: ${(raw.text_raw || '').slice(0, 60).replace(/\n/g, ' ')}`);
    }
  }
  console.log(`geo 命中: ${geoCount}/${rawPosts.length}  签到卡片命中: ${checkinCount}/${rawPosts.length}\n`);
}

async function main() {
  const args = process.argv.slice(2);
  const opt = (name, def) => {
    const i = args.indexOf(`--${name}`);
    return i !== -1 ? args[i + 1] : def;
  };
  const flag = (name) => args.includes(`--${name}`);

  const uid = opt('uid');
  const name = opt('name', uid);
  if (!uid) { console.error('缺少 --uid'); process.exit(1); }

  const probe = flag('probe');
  const mode = opt('mode', 'incremental'); // incremental | full
  const maxPages = Number(opt('max-pages')) || (probe ? 2 : Infinity);

  const dir = dataDir(name);
  const existing = probe ? [] : loadExisting(dir);
  const knownIds = new Set(existing.map(p => String(p.id)));
  console.log(`用户: ${name} (uid=${uid})  已存动态: ${existing.length}  模式: ${probe ? 'probe' : mode}`);

  const collected = [];
  const rawSample = []; // probe 模式下用于字段巡检
  let page = 1, total = null, stopped = false;

  while (page <= maxPages) {
    let data;
    try {
      data = await fetchPageWithRetry(uid, page);
    } catch (e) {
      console.error(`第 ${page} 页请求失败,停止(已抓 ${collected.length} 条): ${e.message}`);
      break;
    }
    if (total == null) total = data.total;
    const list = data.list || [];
    if (list.length === 0) { console.log('已到最后一页(空列表)'); break; }

    if (probe) rawSample.push(...list);

    for (const raw of list) {
      if (mode === 'incremental' && !probe && knownIds.has(String(raw.id))) {
        console.log(`遇到已存过的动态 id=${raw.id},增量抓取到此结束`);
        stopped = true;
        break;
      }
      collected.push(normalizePost(raw, uid));
    }
    console.log(`第 ${page} 页  本次累计 ${collected.length} 条  (总量约 ${total})`);
    if (stopped) break;

    page++;
    await delay(1500 + Math.random() * 1500);
  }

  if (probe) {
    surveyLocationFields(rawSample);
    console.log(`(probe 模式不落盘 posts_raw.json;确认字段结构后去掉 --probe 正式抓取)`);
    return;
  }

  const merged = mergePosts(existing, collected);
  savePosts(dir, merged);
  console.log(`\n完成:新增 ${collected.length} 条,合计 ${merged.length} 条,已存 ${path.join(dir, 'posts_raw.json')}`);
}

main().catch(e => { console.error(e); process.exit(1); });
