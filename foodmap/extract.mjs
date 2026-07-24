// 从带位置标记的微博动态里,批量抽取"是否为餐馆/推荐菜品"的纯逻辑
// (prompt 构造、LLM 输出解析、按餐厅名聚合去重)。不含网络 IO,便于单测。
//
// 输出协议选用管道分隔的行式文本而非 JSON:同类项目(qa-agent 的话题块标注)
// 已验证过,聊天/社交文本常带引号、换行,让模型生成合法转义的 JSON 数组
// 很容易出错;行式协议只需按行 split('|'),即使某个字段里偶然出现多余的
// "|" 也能靠"前 3 段是索引/餐厅名/菜品,剩余全部拼回摘要"的方式兜底解析。

const NOT_RESTAURANT = new Set(['无', 'none', '', 'null']);

/** 单条候选动态 → 送入 LLM 的文本片段(截断,附加签到卡片提示)。 */
export function buildCandidateText(post, maxLen = 400) {
  const hint = post.checkinTitle ? `[签到:${post.checkinTitle}] ` : '';
  const text = (post.textRaw || '').replace(/\s+/g, ' ').trim().slice(0, maxLen);
  return hint + text;
}

export function buildExtractionPrompt(candidateTexts) {
  const list = candidateTexts.map((t, i) => `【${i}】${t}`).join('\n');
  return `以下是美食博主的 ${candidateTexts.length} 条带地理位置的微博动态。请判断每条是否在描述一次具体的餐馆/店铺就餐体验,如果是,提取餐厅名称、文字里明确提到的城市(比如"上海探店""成都本地小馆"里的上海/成都;没提到具体城市就留空,不要瞎猜)、以及提到的推荐菜品;如果不是(比如只是路过、谈论别的话题、看不出具体餐厅名),餐厅名填"无"。

${list}

输出格式:每条一行,格式为"编号|餐厅名|城市|菜品1,菜品2|一句话引用或概括(不确定菜品可留空,但尽量给出简短摘要)"。不要输出其他文字。例如:
0|又益轩|桂林|马肉米粉|离开桂林前在又益轩吃了马肉米粉，这种传统米粉已经好多年没吃过了
1|无|||`;
}

/**
 * 解析 LLM 行式输出。返回长度为 expectedCount 的数组,每项:
 *   { name, city, dishes: string[], quote } 或 null(非餐馆/解析失败)。
 */
export function parseExtractionResponse(text, expectedCount) {
  const out = new Array(expectedCount).fill(null);
  for (const line of String(text).split('\n')) {
    const m = line.match(/^\s*(\d+)\s*\|(.*)$/);
    if (!m) continue;
    const i = Number(m[1]);
    if (!(i >= 0 && i < expectedCount)) continue;
    const parts = m[2].split('|');
    if (parts.length < 4) continue;
    const name = (parts[0] || '').trim();
    if (NOT_RESTAURANT.has(name.toLowerCase())) continue;
    const city = (parts[1] || '').trim() || null;
    const dishes = (parts[2] || '').split(/[,，、]/).map(s => s.trim()).filter(Boolean);
    const quote = parts.slice(3).join('|').trim();
    out[i] = { name, city, dishes, quote };
  }
  return out;
}

/** 餐厅名归一化(去空白/统一大小写),仅用于聚合去重的比较键。 */
function normalizeName(name) {
  return name.replace(/\s+/g, '').toLowerCase();
}

/** 众数(出现次数最多的取值);全为空/无输入时返回 null。 */
function mode(values) {
  const counts = new Map();
  for (const v of values) {
    if (!v) continue;
    counts.set(v, (counts.get(v) || 0) + 1);
  }
  let best = null, bestCount = 0;
  for (const [v, c] of counts) {
    if (c > bestCount) { best = v; bestCount = c; }
  }
  return best;
}

/**
 * 按餐厅名聚合多次拜访。入参每项需含 { name, dishes, quote, geo, createdAt, postUrl, postId, regionName }。
 * geo 缺失的候选仍会被收录(dishes/quote 有价值),但不参与地图落点——
 * 由调用方决定是否过滤掉 lat/lng 为 null 的结果。
 */
export function aggregateRestaurants(extracted) {
  const byKey = new Map();
  for (const item of extracted) {
    const key = normalizeName(item.name);
    if (!byKey.has(key)) {
      byKey.set(key, {
        name: item.name, // 保留首次出现的原始写法作为展示名
        lat: item.geo?.lat ?? null,
        lng: item.geo?.lng ?? null,
        visits: [],
        _regions: [], // 临时字段,聚合完后折叠成 region 并删除
        _cityHints: [], // 临时字段,聚合完后折叠成 cityHint 并删除
      });
    }
    const entry = byKey.get(key);
    if (entry.lat == null && item.geo) { entry.lat = item.geo.lat; entry.lng = item.geo.lng; }
    entry._regions.push(item.regionName || null);
    entry._cityHints.push(item.city || null);
    entry.visits.push({
      date: item.createdAt,
      postId: item.postId,
      postUrl: item.postUrl,
      dishes: item.dishes,
      quote: item.quote,
    });
  }
  // 每家餐厅按拜访时间升序排列,便于地图卡片展示"第一次/最近一次"
  for (const r of byKey.values()) {
    r.visits.sort((a, b) => Date.parse(a.date || 0) - Date.parse(b.date || 0));
    // 微博的 region_name 是发帖时的 IP 归属地(粗粒度),同一家店多次拜访
    // 偶尔会因为发帖设备/网络环境不同而不一致,取众数作为该店的代表地区,
    // 供"按地区筛选"用——不是精确地址。
    r.region = mode(r._regions);
    delete r._regions;
    // cityHint 是 LLM 从文字里读出来的城市(比如"探店成都xx"里的成都),
    // 跟上面的 region 是两回事:region 是发帖时人在哪(IP),cityHint 是
    // 文字描述的餐厅实际所在城市。按名称正向搜索坐标(geocode-regions.mjs
    // 的 forwardGeocodeByName)时应该优先用 cityHint,不然博主人在北京却
    // 探店成都,用 IP 归属地"北京"当搜索线索会系统性地搜偏。
    r.cityHint = mode(r._cityHints);
    delete r._cityHints;
  }
  return [...byKey.values()];
}
