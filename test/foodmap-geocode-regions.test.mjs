import { test } from 'node:test';
import assert from 'node:assert';
import { reverseGeocodeLocation, forwardGeocodeByName } from '../foodmap/geocode-regions.mjs';

function mockFetchOnce(addressObj) {
  globalThis.fetch = async () => ({ ok: true, json: async () => ({ address: addressObj }) });
}

test('reverseGeocodeLocation: 从 country_code 推出洲,取国家/省/市各级字段', async () => {
  mockFetchOnce({ country_code: 'cn', country: '中国', state: '广东省', city: '广州市' });
  assert.deepStrictEqual(await reverseGeocodeLocation(23.13, 113.26), {
    continent: '亚洲', country: '中国', province: '广东省', city: '广州市',
  });
});

test('reverseGeocodeLocation: city 缺失时退化到 county', async () => {
  mockFetchOnce({ country_code: 'fr', country: '法国', state: 'Provence-Alpes-Côte d\'Azur', county: '滨海阿尔卑斯省' });
  const r = await reverseGeocodeLocation(43.55, 6.99);
  assert.strictEqual(r.continent, '欧洲');
  assert.strictEqual(r.city, '滨海阿尔卑斯省');
});

test('reverseGeocodeLocation: 分号拼接的多语言地名只取第一段', async () => {
  mockFetchOnce({ country_code: 'us', country: '美国;美國', state: '新泽西州;新澤西州;紐澤西州', county: 'Hudson County' });
  const r = await reverseGeocodeLocation(40.74, -74.06);
  assert.strictEqual(r.continent, '北美洲');
  assert.strictEqual(r.country, '美国');
  assert.strictEqual(r.province, '新泽西州');
});

test('reverseGeocodeLocation: 未知国家代码时 continent 为 null,其余字段仍正常', async () => {
  mockFetchOnce({ country_code: 'xx', country: '未知国', state: '某省', city: '某市' });
  const r = await reverseGeocodeLocation(0, 0);
  assert.strictEqual(r.continent, null);
  assert.strictEqual(r.country, '未知国');
});

test('reverseGeocodeLocation: 地址信息全空时各级均为 null,不抛错', async () => {
  mockFetchOnce({});
  assert.deepStrictEqual(await reverseGeocodeLocation(0, 0), {
    continent: null, country: null, province: null, city: null,
  });
});

test('reverseGeocodeLocation: HTTP 非 200 时抛错(由调用方决定是否保留原值)', async () => {
  globalThis.fetch = async () => ({ ok: false, status: 429 });
  await assert.rejects(() => reverseGeocodeLocation(1, 1), /Nominatim 429/);
});

test('forwardGeocodeByName: 命中结果时返回第一条的坐标', async () => {
  globalThis.fetch = async () => ({ ok: true, json: async () => ([{ lat: '39.9042', lon: '116.4074' }]) });
  const r = await forwardGeocodeByName('全聚德', '北京');
  assert.deepStrictEqual(r, { lat: 39.9042, lng: 116.4074 });
});

test('forwardGeocodeByName: 空结果返回 null,不抛错(店名搜不到是正常情况)', async () => {
  globalThis.fetch = async () => ({ ok: true, json: async () => ([]) });
  assert.strictEqual(await forwardGeocodeByName('查无此店', '某地'), null);
});

test('forwardGeocodeByName: 没有城市线索时也能查(拼接时自动跳过空值)', async () => {
  let capturedUrl;
  globalThis.fetch = async (url) => { capturedUrl = url; return { ok: true, json: async () => ([{ lat: '1', lon: '2' }]) }; };
  await forwardGeocodeByName('星冈', null);
  assert.match(capturedUrl, /q=%E6%98%9F%E5%86%88(&|$)/); // 只有店名,没有多拼一个空格/undefined
});

test('forwardGeocodeByName: 默认限定国家为中国,避免模糊匹配跑到国外', async () => {
  let capturedUrl;
  globalThis.fetch = async (url) => { capturedUrl = url; return { ok: true, json: async () => ([{ lat: '1', lon: '2' }]) }; };
  await forwardGeocodeByName('华商', '成都');
  assert.match(capturedUrl, /countrycodes=cn/);
});

test('forwardGeocodeByName: 传入 countryCode 可以覆盖默认值,传空字符串则不加限定', async () => {
  let capturedUrl;
  globalThis.fetch = async (url) => { capturedUrl = url; return { ok: true, json: async () => ([{ lat: '1', lon: '2' }]) }; };
  await forwardGeocodeByName('some place', 'Paris', 'fr');
  assert.match(capturedUrl, /countrycodes=fr/);
  await forwardGeocodeByName('some place', 'Paris', '');
  assert.doesNotMatch(capturedUrl, /countrycodes/);
});

test('forwardGeocodeByName: HTTP 非 200 时抛错', async () => {
  globalThis.fetch = async () => ({ ok: false, status: 503 });
  await assert.rejects(() => forwardGeocodeByName('随便什么店', '北京'), /Nominatim 503/);
});
