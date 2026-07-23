import { test } from 'node:test';
import assert from 'node:assert';
import { buildCandidateText, buildExtractionPrompt, parseExtractionResponse, aggregateRestaurants } from '../foodmap/extract.mjs';

test('buildCandidateText: 附加签到提示,截断超长文本,压平换行', () => {
  const t = buildCandidateText({ textRaw: '在\n星冈\n吃了午餐', checkinTitle: null });
  assert.strictEqual(t, '在 星冈 吃了午餐');
  const withHint = buildCandidateText({ textRaw: '很晚的晚餐', checkinTitle: '桂花公社景区' });
  assert.strictEqual(withHint, '[签到:桂花公社景区] 很晚的晚餐');
  const long = buildCandidateText({ textRaw: 'x'.repeat(500) }, 50);
  assert.strictEqual(long.length, 50);
});

test('buildExtractionPrompt: 按编号列出候选文本', () => {
  const p = buildExtractionPrompt(['吃了米粉', '路过桂林']);
  assert.match(p, /【0】吃了米粉/);
  assert.match(p, /【1】路过桂林/);
  assert.match(p, /编号\|餐厅名\|菜品/);
});

test('parseExtractionResponse: 正常解析餐厅名/菜品/摘要', () => {
  const out = parseExtractionResponse(
    '0|又益轩|马肉米粉|离开桂林前吃了马肉米粉\n1|无||',
    2
  );
  assert.deepStrictEqual(out[0], { name: '又益轩', dishes: ['马肉米粉'], quote: '离开桂林前吃了马肉米粉' });
  assert.strictEqual(out[1], null);
});

test('parseExtractionResponse: 餐厅名"无"(不分大小写)判定为非餐馆', () => {
  const out = parseExtractionResponse('0|无||\n1|None||\n2|NULL||', 3);
  assert.deepStrictEqual(out, [null, null, null]);
});

test('parseExtractionResponse: 摘要里意外出现的竖线被拼回摘要而不截断', () => {
  const out = parseExtractionResponse('0|星冈|生蚝,和牛|老板说 A|B 两个套餐都不错', 1);
  assert.strictEqual(out[0].quote, '老板说 A|B 两个套餐都不错');
});

test('parseExtractionResponse: 越界编号/格式错误行忽略,不抛错', () => {
  const out = parseExtractionResponse('9|越界||\n完全没有格式\n0|星冈|生蚝|好吃', 1);
  assert.strictEqual(out[0].name, '星冈');
});

test('aggregateRestaurants: 同名餐厅合并为一条,多次拜访按时间升序', () => {
  const extracted = [
    { name: '星冈', dishes: ['生蚝'], quote: '第一次', geo: { lat: 39.9, lng: 116.4 }, createdAt: 'Thu Jul 10 2026', postId: 1, postUrl: 'u1', regionName: '北京' },
    { name: ' 星冈 ', dishes: ['和牛'], quote: '第二次', geo: null, createdAt: 'Thu Jul 20 2026', postId: 2, postUrl: 'u2', regionName: '北京' },
    { name: '又益轩', dishes: ['马肉米粉'], quote: '桂林', geo: { lat: 25.3, lng: 110.3 }, createdAt: 'Thu Jul 05 2026', postId: 3, postUrl: 'u3', regionName: '广西' },
  ];
  const r = aggregateRestaurants(extracted);
  assert.strictEqual(r.length, 2);
  const xingang = r.find(x => x.name === '星冈');
  assert.strictEqual(xingang.visits.length, 2);
  assert.strictEqual(xingang.lat, 39.9); // 沿用首次出现时的坐标
  assert.strictEqual(xingang.visits[0].quote, '第一次'); // 时间升序
  assert.strictEqual(xingang.visits[1].quote, '第二次');
  assert.strictEqual(xingang.region, '北京');
  assert.strictEqual(r.find(x => x.name === '又益轩').region, '广西');
});

test('aggregateRestaurants: region 取众数,不一致时以出现次数最多的为准', () => {
  const r = aggregateRestaurants([
    { name: 'X', dishes: [], quote: 'a', geo: { lat: 1, lng: 1 }, createdAt: 't1', postId: 1, postUrl: 'u1', regionName: '广东' },
    { name: 'X', dishes: [], quote: 'b', geo: { lat: 1, lng: 1 }, createdAt: 't2', postId: 2, postUrl: 'u2', regionName: '广东' },
    { name: 'X', dishes: [], quote: 'c', geo: { lat: 1, lng: 1 }, createdAt: 't3', postId: 3, postUrl: 'u3', regionName: '海外' },
  ]);
  assert.strictEqual(r[0].region, '广东');
});

test('aggregateRestaurants: regionName 缺失不报错,region 为 null', () => {
  const r = aggregateRestaurants([{ name: 'Y', dishes: [], quote: 'q', geo: null, createdAt: 't', postId: 1, postUrl: 'u' }]);
  assert.strictEqual(r[0].region, null);
});

test('aggregateRestaurants: 无 geo 的候选也保留在结果里(由调用方决定是否上图)', () => {
  const r = aggregateRestaurants([{ name: 'X', dishes: [], quote: 'q', geo: null, createdAt: 't', postId: 1, postUrl: 'u' }]);
  assert.strictEqual(r[0].lat, null);
});
