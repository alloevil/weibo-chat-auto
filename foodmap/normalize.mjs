// 微博个人主页动态的字段裁剪与归一化。纯函数,不含网络/文件 IO,便于单测。
//
// 实地探测结论(陈晓卿账号 uid=1647375747 抓取样本,2026-07):
//   - 位置信号主字段是 `geo: {type:'Point', coordinates:[lat, lng]}`,
//     注意坐标顺序是 [纬度, 经度] —— 与标准 GeoJSON [经度, 纬度] 相反,
//     照抄会把点画到错误位置(经纬度对调后可能落到地球另一端)。
//     样本覆盖率约 52%(13/25),均为原创动态(非转发)。
//   - `url_struct[].object_type === 'place'` 是签到卡片,带 POI 名称
//     (`url_title`),但样本中出现率低(1/25)且不保证与餐馆相关
//     (曾观察到挂在一条无关回复上的景区签到),只作为辅助线索,不单独
//     作为收录条件。
//   - `region_name`(如"发布于 湖南")是发布时的 IP 归属地,粒度粗,
//     不能当作餐馆地址使用。
//   - POI 名称/推荐菜品不在结构化字段里,需要从 `text_raw` 用 LLM 抽取。

/** 微博 geo 字段 → {lat, lng},非法/缺失返回 null。 */
export function parseGeo(geo) {
  if (!geo || typeof geo !== 'object' || geo.type !== 'Point') return null;
  const c = geo.coordinates;
  if (!Array.isArray(c) || c.length !== 2) return null;
  const [lat, lng] = c;
  if (typeof lat !== 'number' || typeof lng !== 'number') return null;
  if (lat < -90 || lat > 90 || lng < -180 || lng > 180) return null;
  return { lat, lng };
}

/** 签到卡片(url_struct 里 object_type==='place')的标题,没有则 null。 */
function parseCheckinTitle(urlStruct) {
  if (!Array.isArray(urlStruct)) return null;
  const place = urlStruct.find(u => u && u.object_type === 'place');
  return place?.url_title || null;
}

export function buildPostUrl(uid, mblogid) {
  return `https://weibo.com/${uid}/${mblogid}`;
}

/**
 * 微博原始动态对象 → 精简字段集,只保留下游(位置识别/LLM抽取/地图展示)
 * 需要的字段,避免把 40+ 字段的原始对象全量落盘。
 */
export function normalizePost(raw, uid) {
  const geo = parseGeo(raw.geo);
  const checkinTitle = parseCheckinTitle(raw.url_struct);
  return {
    id: raw.id,
    mblogid: raw.mblogid,
    createdAt: raw.created_at, // 原始格式如 "Thu Jul 16 19:42:01 +0800 2026",下游按需 Date.parse
    textRaw: raw.text_raw || '',
    geo,
    checkinTitle,
    isRetweet: !!raw.retweeted_status,
    picNum: raw.pic_num || 0,
    postUrl: raw.mblogid ? buildPostUrl(uid, raw.mblogid) : null,
  };
}

/** 是否带位置信号(geo 优先;签到卡片作为补充)。 */
export function hasLocationSignal(post) {
  return !!post.geo || !!post.checkinTitle;
}

/** 按 id 合并去重(新数据覆盖旧数据,同 id 以后抓的为准),按 id 升序排序。 */
export function mergePosts(existing, incoming) {
  const byId = new Map(existing.map(p => [String(p.id), p]));
  for (const p of incoming) byId.set(String(p.id), p);
  return [...byId.values()].sort((a, b) => Number(a.id) - Number(b.id));
}
