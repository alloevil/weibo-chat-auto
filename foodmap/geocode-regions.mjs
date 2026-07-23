// 用坐标反向地理编码算出每家餐厅的省市(比发帖时的 IP 归属地准——发帅
// 微博用的设备/网络位置不一定等于餐厅所在地)。用 OpenStreetMap 的
// Nominatim(免费、不需要 API key),按其使用条款限速 1 请求/秒。
//
// 只在反查成功时覆盖 restaurants.json 里的 region 字段;失败(网络问题/
// 限速)保留原有值——那是聚合时从发帖 IP 算出的众数,精度差一些但总比没有强。
//
// 用法: node foodmap/geocode-regions.mjs --name 陈晓卿
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = __dirname;
const NOMINATIM_DELAY_MS = 1100; // Nominatim 使用条款:不超过 1 请求/秒

function dataDir(name) {
  const safe = name.replace(/[^a-zA-Z0-9一-鿿]/g, '_');
  return path.join(ROOT, 'data', safe);
}

function delay(ms) {
  return new Promise(r => setTimeout(r, ms));
}

/** 反查 {lat,lng} 的省市名(城市优先,城市/直辖市二者取一);失败返回 null。 */
export async function reverseGeocodeRegion(lat, lng) {
  const url = `https://nominatim.openstreetmap.org/reverse?format=jsonv2&lat=${lat}&lon=${lng}&zoom=6&accept-language=zh`;
  const resp = await fetch(url, { headers: { 'User-Agent': 'foodmap-demo/1.0 (personal project, see github.com/alloevil/foodmap)' } });
  if (!resp.ok) throw new Error(`Nominatim ${resp.status}`);
  const data = await resp.json();
  const raw = data.address?.city || data.address?.state || data.address?.country || null;
  // 有些地区(尤其海外)Nominatim 返回"英文;繁体;简体"用分号拼接的多语言名,
  // 只取第一段,避免"新泽西州;新澤西州;紐澤西州"这种重复堆砌
  return raw ? raw.split(';')[0].trim() : null;
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
  // 250 家餐厅往往集中在几十个城市里
  const cache = new Map();
  const cacheKey = (lat, lng) => `${lat.toFixed(1)},${lng.toFixed(1)}`;

  let queried = 0, failed = 0, reused = 0;
  for (const r of restaurants) {
    if (r.lat == null || r.lng == null) continue;
    const key = cacheKey(r.lat, r.lng);
    if (cache.has(key)) {
      r.region = cache.get(key) ?? r.region;
      reused++;
      continue;
    }
    try {
      const region = await reverseGeocodeRegion(r.lat, r.lng);
      cache.set(key, region);
      if (region) r.region = region;
      queried++;
      await delay(NOMINATIM_DELAY_MS);
    } catch (e) {
      console.warn(`反查失败,保留原地区(${r.region ?? '无'}): ${r.name} - ${e.message}`);
      cache.set(key, null);
      failed++;
    }
    if ((queried + failed) % 20 === 0) console.log(`进度 ${queried + failed + reused}/${restaurants.length}`);
  }

  fs.writeFileSync(file, JSON.stringify(restaurants, null, 2));
  console.log(`完成: 反查 ${queried} 次,坐标复用 ${reused} 次,失败 ${failed} 次(已保留原地区)`);
}

if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) {
  main().catch(e => { console.error(e); process.exit(1); });
}
