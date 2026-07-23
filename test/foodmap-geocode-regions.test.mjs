import { test } from 'node:test';
import assert from 'node:assert';
import { reverseGeocodeRegion } from '../foodmap/geocode-regions.mjs';

function mockFetchOnce(addressObj) {
  globalThis.fetch = async () => ({ ok: true, json: async () => ({ address: addressObj }) });
}

test('reverseGeocodeRegion: 优先取 city,其次 state,再其次 country', async () => {
  mockFetchOnce({ city: '广州市', state: '广东省' });
  assert.strictEqual(await reverseGeocodeRegion(23.13, 113.26), '广州市');

  mockFetchOnce({ state: '上海市' }); // 直辖市在某些缩放级别只有 state 字段
  assert.strictEqual(await reverseGeocodeRegion(31.23, 121.47), '上海市');

  mockFetchOnce({ country: '日本' });
  assert.strictEqual(await reverseGeocodeRegion(35.68, 139.69), '日本');
});

test('reverseGeocodeRegion: 分号拼接的多语言地名只取第一段', async () => {
  mockFetchOnce({ city: '纽约;紐約', state: '纽约州;紐約州' });
  assert.strictEqual(await reverseGeocodeRegion(40.71, -74.0), '纽约');
});

test('reverseGeocodeRegion: 地址信息全空时返回 null', async () => {
  mockFetchOnce({});
  assert.strictEqual(await reverseGeocodeRegion(0, 0), null);
});

test('reverseGeocodeRegion: HTTP 非 200 时抛错(由调用方决定是否保留原值)', async () => {
  globalThis.fetch = async () => ({ ok: false, status: 429 });
  await assert.rejects(() => reverseGeocodeRegion(1, 1), /Nominatim 429/);
});
