import { test } from 'node:test';
import assert from 'node:assert';
import { reverseGeocodeLocation } from '../foodmap/geocode-regions.mjs';

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
