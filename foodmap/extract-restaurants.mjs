// 从 posts_raw.json 里筛出带位置标记的动态,批量调 LLM 判断是否为餐馆就餐、
// 抽取推荐菜品,按餐厅名聚合去重,写出 restaurants.json。
//
// 用法: node foodmap/extract-restaurants.mjs --name 陈晓卿 [--batch-size 8] [--limit N]
//
// 有些博主的动态完全不打官方位置标记/签到卡片(只在文字里提到店名),
// 加 --by-name 换成"LLM 抽店名 → 按店名+城市正向搜索坐标"这条路,见下面
// forwardGeocodeByName 的用法和准确性说明。
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { hasLocationSignal } from './normalize.mjs';
import { buildCandidateText, buildExtractionPrompt, parseExtractionResponse, aggregateRestaurants } from './extract.mjs';
import { forwardGeocodeByName } from './geocode-regions.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = __dirname;
const NOMINATIM_DELAY_MS = 1100; // Nominatim 使用条款:不超过 1 请求/秒,跟 geocode-regions.mjs 保持一致

function dataDir(name) {
  const safe = name.replace(/[^a-zA-Z0-9一-鿿]/g, '_');
  return path.join(ROOT, 'data', safe);
}

function delay(ms) {
  return new Promise(r => setTimeout(r, ms));
}

async function callLLM(config, prompt) {
  const resp = await fetch(`${config.baseUrl}/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${config.apiKey}` },
    body: JSON.stringify({ model: config.model, messages: [{ role: 'user', content: prompt }], stream: false }),
  });
  if (!resp.ok) throw new Error(`LLM API ${resp.status}`);
  const data = await resp.json();
  return data.choices?.[0]?.message?.content || '';
}

async function main() {
  const args = process.argv.slice(2);
  const opt = (name, def) => {
    const i = args.indexOf(`--${name}`);
    return i !== -1 ? args[i + 1] : def;
  };

  const name = opt('name');
  if (!name) { console.error('缺少 --name'); process.exit(1); }
  const batchSize = Number(opt('batch-size')) || 8;
  const limit = Number(opt('limit')) || Infinity;
  const byName = args.includes('--by-name');

  const dir = dataDir(name);
  const posts = JSON.parse(fs.readFileSync(path.join(dir, 'posts_raw.json'), 'utf-8'));
  const aiConfig = JSON.parse(fs.readFileSync(path.join(ROOT, 'ai-config.json'), 'utf-8'));

  // 只收原创动态;转发的位置/内容属于被转发者,不归属博主本人的拜访。
  // --by-name 模式没有 geo/签到字段可以预筛,只能把全部原创动态都送给
  // LLM 自己判断"是不是在写一次具体的就餐体验"
  const candidates = (byName ? posts.filter(p => !p.isRetweet) : posts.filter(p => !p.isRetweet && hasLocationSignal(p))).slice(0, limit);
  console.log(byName
    ? `动态总数: ${posts.length}  非转发(--by-name,不筛位置信号): ${candidates.length}`
    : `动态总数: ${posts.length}  带位置信号且非转发: ${candidates.length}`);

  const extracted = [];
  let llmCalls = 0, skipped = 0, parseFailed = 0;

  for (let i = 0; i < candidates.length; i += batchSize) {
    const batch = candidates.slice(i, i + batchSize);
    const texts = batch.map(p => buildCandidateText(p));
    let results;
    try {
      llmCalls++;
      const raw = await callLLM(aiConfig, buildExtractionPrompt(texts));
      results = parseExtractionResponse(raw, batch.length);
    } catch (e) {
      console.warn(`批次 ${i}-${i + batch.length} 抽取失败,跳过: ${e.message}`);
      parseFailed += batch.length;
      continue;
    }
    batch.forEach((post, j) => {
      const r = results[j];
      if (!r) { skipped++; return; }
      extracted.push({
        name: r.name, city: r.city, dishes: r.dishes, quote: r.quote,
        geo: post.geo, createdAt: post.createdAt, postId: post.id, postUrl: post.postUrl,
        regionName: post.regionName,
      });
    });
    console.log(`进度 ${Math.min(i + batchSize, candidates.length)}/${candidates.length}  已识别餐厅动态 ${extracted.length}`);
  }

  const aggregated = aggregateRestaurants(extracted);

  let geocoded = 0, geocodeFailed = 0;
  if (byName) {
    const noCoord = aggregated.filter(r => r.lat == null);
    console.log(`\n${noCoord.length} 家没有自带坐标,按店名+城市正向搜索(限速 1 请求/秒,优先用文字里提到的城市,没提到才退回发帖 IP 归属地;同名连锁店只会取搜索结果第一条,可能对不上博主实际去的分店)...`);
    for (const r of noCoord) {
      try {
        const hit = await forwardGeocodeByName(r.name, r.cityHint || r.region);
        if (hit) { r.lat = hit.lat; r.lng = hit.lng; geocoded++; } else { geocodeFailed++; }
      } catch (e) {
        console.warn(`按名搜索失败,跳过: ${r.name} - ${e.message}`);
        geocodeFailed++;
      }
      await delay(NOMINATIM_DELAY_MS);
    }
    for (const r of aggregated) delete r.cityHint; // 只是内部搜索线索,不进最终的 restaurants.json
  }

  const restaurants = aggregated.filter(r => r.lat != null);
  const noGeoCount = aggregated.length - restaurants.length;

  fs.writeFileSync(path.join(dir, 'restaurants.json'), JSON.stringify(restaurants, null, 2));
  console.log(`\n完成: LLM 调用 ${llmCalls} 次,非餐馆/跳过 ${skipped} 条,解析失败 ${parseFailed} 条`);
  if (byName) console.log(`按名搜索: 命中 ${geocoded} 家,未命中 ${geocodeFailed} 家`);
  console.log(`识别出 ${restaurants.length} 家有坐标的餐厅(另有 ${noGeoCount} 家因无坐标未上图),已存 ${path.join(dir, 'restaurants.json')}`);
}

main().catch(e => { console.error(e); process.exit(1); });
