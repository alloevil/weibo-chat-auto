// 用坐标反向地理编码算出每家餐厅的洲/国/省/市(比发帖时的 IP 归属地准——
// 发微博用的设备/网络位置不一定等于餐厅所在地)。用 OpenStreetMap 的
// Nominatim(免费、不需要 API key),按其使用条款限速 1 请求/秒。
//
// 只在反查成功时覆盖 restaurants.json 里的 location 字段;失败(网络问题/
// 限速)保留原有值不动。
//
// 用法: node foodmap/geocode-regions.mjs --name 陈晓卿
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = __dirname;
const NOMINATIM_DELAY_MS = 1100; // Nominatim 使用条款:不超过 1 请求/秒

// ISO 3166-1 alpha-2 国家代码 → 洲。不追求覆盖全部 249 个代码,只保证
// 常见国家都能对上;查不到的返回 null(前端会归到"其他"分组),不影响
// 国家/省/市三级筛选,只是没有洲这一层。
const COUNTRY_TO_CONTINENT = {
  cn: '亚洲', hk: '亚洲', mo: '亚洲', tw: '亚洲', jp: '亚洲', kr: '亚洲', kp: '亚洲',
  sg: '亚洲', my: '亚洲', th: '亚洲', vn: '亚洲', ph: '亚洲', id: '亚洲', mm: '亚洲',
  kh: '亚洲', la: '亚洲', bn: '亚洲', in: '亚洲', pk: '亚洲', bd: '亚洲', lk: '亚洲',
  np: '亚洲', mn: '亚洲', kz: '亚洲', uz: '亚洲', ae: '亚洲', sa: '亚洲', qa: '亚洲',
  il: '亚洲', tr: '亚洲', ir: '亚洲', iq: '亚洲', jo: '亚洲', kw: '亚洲', lb: '亚洲',
  gb: '欧洲', fr: '欧洲', de: '欧洲', it: '欧洲', es: '欧洲', pt: '欧洲', nl: '欧洲',
  be: '欧洲', ch: '欧洲', at: '欧洲', se: '欧洲', no: '欧洲', dk: '欧洲', fi: '欧洲',
  ie: '欧洲', pl: '欧洲', cz: '欧洲', gr: '欧洲', hu: '欧洲', ro: '欧洲', ru: '欧洲',
  ua: '欧洲', is: '欧洲', lu: '欧洲', hr: '欧洲', rs: '欧洲', bg: '欧洲', sk: '欧洲',
  us: '北美洲', ca: '北美洲', mx: '北美洲', cu: '北美洲', jm: '北美洲', pa: '北美洲',
  br: '南美洲', ar: '南美洲', cl: '南美洲', pe: '南美洲', co: '南美洲', ve: '南美洲',
  ec: '南美洲', uy: '南美洲', py: '南美洲', bo: '南美洲',
  za: '非洲', eg: '非洲', ma: '非洲', ng: '非洲', ke: '非洲', et: '非洲', gh: '非洲',
  tz: '非洲', dz: '非洲', tn: '非洲',
  au: '大洋洲', nz: '大洋洲', fj: '大洋洲', pg: '大洋洲', mp: '大洋洲', gu: '大洋洲',
};

function dataDir(name) {
  const safe = name.replace(/[^a-zA-Z0-9一-鿿]/g, '_');
  return path.join(ROOT, 'data', safe);
}

function delay(ms) {
  return new Promise(r => setTimeout(r, ms));
}

/** Nominatim 有时把"英文;繁体;简体"用分号拼在一起,只取第一段。 */
function firstName(raw) {
  return raw ? raw.split(';')[0].trim() : null;
}

/**
 * 反查 {lat,lng} 的行政层级。country_code 几乎总是有;province/city 按各国
 * 行政体系取最贴近的字段,查不到就留 null(前端筛选时该级显示"全部")。
 * 失败(HTTP 错误等)抛错,由调用方决定是否保留旧值。
 */
export async function reverseGeocodeLocation(lat, lng) {
  const url = `https://nominatim.openstreetmap.org/reverse?format=jsonv2&lat=${lat}&lon=${lng}&zoom=8&accept-language=zh`;
  const resp = await fetch(url, { headers: { 'User-Agent': 'foodmap-demo/1.0 (personal project, see github.com/alloevil/foodmap)' } });
  if (!resp.ok) throw new Error(`Nominatim ${resp.status}`);
  const data = await resp.json();
  const addr = data.address || {};
  const countryCode = (addr.country_code || '').toLowerCase() || null;
  return {
    continent: COUNTRY_TO_CONTINENT[countryCode] || null,
    country: firstName(addr.country),
    province: firstName(addr.state || addr.province),
    // city 字段在乡村/边远地区常缺失,退化到 county(区/县级)作为次优选择
    city: firstName(addr.city || addr.town || addr.municipality || addr.county),
  };
}

/**
 * 反过来:按"餐厅名 + 城市线索"正向搜索坐标——给那些微博动态里完全没打
 * 官方位置标记/签到卡片的博主用(比如只在文字里提到店名),没法像
 * reverseGeocodeLocation 那样从动态自带坐标反查。
 *
 * 准确性上限很明显:同名连锁店(比如"全聚德"全国多个分店)只会拿到搜索
 * 结果排第一的那一家,不一定是博主实际去的那一家分店——这是"只有店名,
 * 没有具体地址"这个数据源本身的局限,不是查询写法能解决的。
 *
 * 查不到(结果为空数组)返回 null,这是正常情况(店名太生僻/连锁店信息
 * 不全/名字打错),不当成异常;HTTP 错误才抛错。
 *
 * countryCode 默认限定在中国(cn)——实测不加这个限制,店名+城市的模糊
 * 匹配偶尔会跑到日本/法国等完全不相关的国家(汉字/常见词撞车),比同名
 * 连锁店选错分店还离谱。这个工具目前服务的都是国内博主,默认限定成本
 * 很低;真遇到海外博主再传别的 countryCode 覆盖。
 */
export async function forwardGeocodeByName(name, regionHint, countryCode = 'cn') {
  const q = [name, regionHint].filter(Boolean).join(' ');
  const cc = countryCode ? `&countrycodes=${countryCode}` : '';
  const url = `https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(q)}&format=jsonv2&limit=1&accept-language=zh${cc}`;
  const resp = await fetch(url, { headers: { 'User-Agent': 'foodmap-demo/1.0 (personal project, see github.com/alloevil/foodmap)' } });
  if (!resp.ok) throw new Error(`Nominatim ${resp.status}`);
  const results = await resp.json();
  const hit = results[0];
  return hit ? { lat: Number(hit.lat), lng: Number(hit.lon) } : null;
}

async function main() {
  const args = process.argv.slice(2);
  const opt = (name, def) => {
    const i = args.indexOf(`--${name}`);
    return i !== -1 ? args[i + 1] : def;
  };
  const name = opt('name');
  if (!name) { console.error('缺少 --name'); process.exit(1); }

  const file = path.join(dataDir(name), 'restaurants.json');
  const restaurants = JSON.parse(fs.readFileSync(file, 'utf-8'));

  // 相近坐标(约同一城市范围内)共用一次查询结果,大幅减少请求数——
  // 250+ 家餐厅往往集中在几十个城市里
  const cache = new Map();
  const cacheKey = (lat, lng) => `${lat.toFixed(1)},${lng.toFixed(1)}`;

  let queried = 0, failed = 0, reused = 0;
  for (const r of restaurants) {
    if (r.lat == null || r.lng == null) continue;
    const key = cacheKey(r.lat, r.lng);
    if (cache.has(key)) {
      if (cache.get(key)) r.location = cache.get(key);
      reused++;
      continue;
    }
    try {
      const location = await reverseGeocodeLocation(r.lat, r.lng);
      cache.set(key, location);
      r.location = location;
      queried++;
      await delay(NOMINATIM_DELAY_MS);
    } catch (e) {
      console.warn(`反查失败,保留原值: ${r.name} - ${e.message}`);
      cache.set(key, null);
      failed++;
    }
    if ((queried + failed) % 20 === 0) console.log(`进度 ${queried + failed + reused}/${restaurants.length}`);
  }

  fs.writeFileSync(file, JSON.stringify(restaurants, null, 2));
  console.log(`完成: 反查 ${queried} 次,坐标复用 ${reused} 次,失败 ${failed} 次(已保留原值)`);
}

if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) {
  main().catch(e => { console.error(e); process.exit(1); });
}
