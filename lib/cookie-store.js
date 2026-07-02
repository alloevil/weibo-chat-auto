// cookies.json 的唯一读写入口。
//
// 背景：此前 5 处代码各自直接 writeFileSync(cookies.json)，其中任何一处在
// 会话失效时误存，都会把有效登录覆盖成失效 Cookie（v1.7.x 连续修的几个 bug
// 全部源于此）。集中到这里后，写入方无法绕过校验：
//   - 必须包含 SUB 登录 Cookie，否则拒绝写入；
//   - 域名统一补前导点（"weibo.com" → ".weibo.com"），否则 puppeteer 会把它
//     设成 host-only Cookie，不发给 api.weibo.com 子域，导致鉴权失败。
'use strict';

const fs = require('fs');
const path = require('path');

const COOKIE_FILE = path.join(__dirname, '..', 'cookies.json');

/** 读取 cookies.json，缺失/损坏时返回 []。 */
function loadCookies() {
    try {
        const list = JSON.parse(fs.readFileSync(COOKIE_FILE, 'utf-8'));
        return Array.isArray(list) ? list : [];
    } catch {
        return [];
    }
}

/** 是否包含 SUB 登录态。 */
function hasLoginCookie(cookies) {
    return Array.isArray(cookies) && cookies.some(c => c && c.name === 'SUB');
}

/** 域名补前导点（原地修改并返回同一数组）。 */
function normalizeDomains(cookies) {
    for (const c of cookies) {
        if (c && c.domain && !c.domain.startsWith('.') && c.domain.includes('.')) {
            c.domain = '.' + c.domain;
        }
    }
    return cookies;
}

/**
 * 保存 Cookie。无 SUB 时拒绝（防止失效会话覆盖有效登录）。
 * @returns {{ok: boolean, count?: number, error?: string}}
 */
function saveCookies(cookies, reason = '') {
    if (!hasLoginCookie(cookies)) {
        const msg = `拒绝保存：无 SUB 登录态${reason ? `（${reason}）` : ''}，保留现有 cookies.json`;
        console.log(`[cookie-store] ${msg}`);
        return { ok: false, error: msg };
    }
    normalizeDomains(cookies);
    fs.writeFileSync(COOKIE_FILE, JSON.stringify(cookies, null, 2));
    console.log(`[cookie-store] 已保存 ${cookies.length} 个 Cookie${reason ? `（${reason}）` : ''}`);
    return { ok: true, count: cookies.length };
}

/** 序列化成请求头 Cookie 字符串。 */
function cookieHeader(cookies = loadCookies()) {
    return cookies.map(c => `${c.name}=${c.value}`).join('; ');
}

/**
 * 从 browser.cookies() 的全量结果中过滤出微博相关域（weibo.com / sina.com.cn），
 * 并按 domain+name 去重。配合 puppeteer 新版 API（page.cookies 已弃用）使用。
 */
function filterWeiboCookies(cookies) {
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

module.exports = { COOKIE_FILE, loadCookies, saveCookies, hasLoginCookie, normalizeDomains, cookieHeader, filterWeiboCookies };
