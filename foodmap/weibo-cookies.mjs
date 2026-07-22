// foodmap 专用的 Cookie 存取,与群聊功能的 lib/cookie-store.js（cookies.json）
// 完全隔离，各自一份文件。
//
// 血泪教训：本功能开发时曾直接把 weibo.com 主站登录产生的 Cookie 存进共享
// 的 cookies.json，`hasLoginCookie` 只检查"存在名为 SUB 的 Cookie"，不检查
// 它是否真的有效——把群聊功能正常工作的登录态覆盖成了未登录占位值，导致
// 群聊归档报 401（error_code 21301）。api.weibo.com/chat 与 weibo.com 主站
// 是两套独立的登录会话，绝不能共用一份 Cookie 文件。
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const COOKIE_FILE = path.join(__dirname, 'cookies.json');

export function loadCookies() {
  try {
    const list = JSON.parse(fs.readFileSync(COOKIE_FILE, 'utf-8'));
    return Array.isArray(list) ? list : [];
  } catch {
    return [];
  }
}

export function hasLoginCookie(cookies) {
  return Array.isArray(cookies) && cookies.some(c => c && c.name === 'SUB');
}

function normalizeDomains(cookies) {
  for (const c of cookies) {
    if (c && c.domain && !c.domain.startsWith('.') && c.domain.includes('.')) {
      c.domain = '.' + c.domain;
    }
  }
  return cookies;
}

export function saveCookies(cookies, reason = '') {
  if (!hasLoginCookie(cookies)) {
    console.log(`[foodmap-cookies] 拒绝保存：无 SUB 登录态${reason ? `（${reason}）` : ''}`);
    return { ok: false, error: '无 SUB 登录态' };
  }
  normalizeDomains(cookies);
  fs.writeFileSync(COOKIE_FILE, JSON.stringify(cookies, null, 2));
  console.log(`[foodmap-cookies] 已保存 ${cookies.length} 个 Cookie${reason ? `（${reason}）` : ''}`);
  return { ok: true, count: cookies.length };
}

export function cookieHeader(cookies = loadCookies()) {
  return cookies.map(c => `${c.name}=${c.value}`).join('; ');
}

export function filterWeiboCookies(cookies) {
  const seen = new Set();
  return (cookies || []).filter(c => {
    if (!c || !c.domain) return false;
    if (!c.domain.includes('weibo.com') && !c.domain.includes('sina.com.cn')) return false;
    const key = c.domain + '|' + c.name;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
