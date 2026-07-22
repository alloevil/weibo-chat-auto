import { test } from 'node:test';
import assert from 'node:assert';
import { parseGeo, buildPostUrl, normalizePost, hasLocationSignal, mergePosts } from '../foodmap/normalize.mjs';

test('parseGeo: 合法 Point 按 [lat,lng] 解析(微博坐标顺序与标准 GeoJSON 相反)', () => {
  // 桂林实际坐标约 25.28N 110.26E,微博 geo.coordinates 数组第一位是纬度
  const r = parseGeo({ type: 'Point', coordinates: [25.280081, 110.264847] });
  assert.deepStrictEqual(r, { lat: 25.280081, lng: 110.264847 });
});

test('parseGeo: 缺失/非 Point/越界坐标返回 null', () => {
  assert.strictEqual(parseGeo(''), null);
  assert.strictEqual(parseGeo(null), null);
  assert.strictEqual(parseGeo(undefined), null);
  assert.strictEqual(parseGeo({ type: 'Polygon', coordinates: [] }), null);
  assert.strictEqual(parseGeo({ type: 'Point', coordinates: [200, 30] }), null); // 纬度越界
  assert.strictEqual(parseGeo({ type: 'Point', coordinates: ['25', '110'] }), null); // 非数字
});

test('buildPostUrl: 拼接 uid/mblogid 形式的微博链接', () => {
  assert.strictEqual(buildPostUrl(1647375747, 'R9e1ajCfY'), 'https://weibo.com/1647375747/R9e1ajCfY');
});

test('normalizePost: 提取签到卡片标题,裁剪冗余字段', () => {
  const raw = {
    id: 5321391748415878, mblogid: 'abc123', created_at: 'Thu Jul 16 19:42:01 +0800 2026',
    text_raw: '在桂花公社', geo: '', pic_num: 2,
    url_struct: [{ object_type: 'webpage' }, { object_type: 'place', url_title: '桂林·桂花公社景区' }],
    retweeted_status: null,
    mblog_feed_back_menus_format: [ /* 应被裁掉 */ ],
  };
  const p = normalizePost(raw, 1647375747);
  assert.strictEqual(p.checkinTitle, '桂林·桂花公社景区');
  assert.strictEqual(p.geo, null);
  assert.strictEqual(p.isRetweet, false);
  assert.strictEqual(p.postUrl, 'https://weibo.com/1647375747/abc123');
  assert.ok(!('mblog_feed_back_menus_format' in p));
});

test('hasLocationSignal: geo 或签到卡片任一存在即为真', () => {
  assert.strictEqual(hasLocationSignal({ geo: { lat: 1, lng: 2 }, checkinTitle: null }), true);
  assert.strictEqual(hasLocationSignal({ geo: null, checkinTitle: '某餐厅' }), true);
  assert.strictEqual(hasLocationSignal({ geo: null, checkinTitle: null }), false);
});

test('mergePosts: 按 id 去重,新数据覆盖旧数据,结果按 id 升序', () => {
  const existing = [{ id: 1, textRaw: 'old' }, { id: 3, textRaw: 'c' }];
  const incoming = [{ id: 2, textRaw: 'b' }, { id: 1, textRaw: 'new' }];
  const merged = mergePosts(existing, incoming);
  assert.deepStrictEqual(merged.map(p => p.id), [1, 2, 3]);
  assert.strictEqual(merged[0].textRaw, 'new');
});
