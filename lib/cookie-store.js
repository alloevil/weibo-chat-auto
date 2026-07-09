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

/**
 * 解析一条 Set-Cookie 响应头为 puppeteer 格式 Cookie。
 * 无法解析、非微博域（weibo.com / sina.com.cn）时返回 null。
 */
function parseSetCookie(line, requestHost = '') {
    if (typeof line !== 'string' || !line.includes('=')) return null;
    const parts = line.split(';');
    const eq = parts[0].indexOf('=');
    const name = parts[0].slice(0, eq).trim();
    const value = parts[0].slice(eq + 1).trim();
    if (!name) return null;

    const cookie = { name, value, domain: requestHost, path: '/', expires: -1, session: true, httpOnly: false, secure: false };
    for (let i = 1; i < parts.length; i++) {
        const seg = parts[i].trim();
        const segEq = seg.indexOf('=');
        const key = (segEq === -1 ? seg : seg.slice(0, segEq)).trim().toLowerCase();
        const val = segEq === -1 ? '' : seg.slice(segEq + 1).trim();
        if (key === 'domain' && val) cookie.domain = val;
        else if (key === 'path' && val) cookie.path = val;
        else if (key === 'max-age' && val !== '' && !isNaN(Number(val))) {
            cookie.expires = Math.floor(Date.now() / 1000) + Number(val);
            cookie.session = false;
        } else if (key === 'expires' && val && cookie.session) {
            // Max-Age 优先于 Expires（RFC 6265）
            const ts = Date.parse(val);
            if (!isNaN(ts)) { cookie.expires = Math.floor(ts / 1000); cookie.session = false; }
        } else if (key === 'secure') cookie.secure = true;
        else if (key === 'httponly') cookie.httpOnly = true;
    }

    if (!cookie.domain.includes('weibo.com') && !cookie.domain.includes('sina.com.cn')) return null;
    return cookie;
}

/** 是否为"删除指令"式 Cookie（空值/deleted 占位，或过期时间在过去）。 */
function isDeletionCookie(c) {
    if (!c.value || c.value.toLowerCase() === 'deleted') return true;
    if (!c.session && c.expires > 0 && c.expires * 1000 < Date.now()) return true;
    return false;
}

/**
 * 吸收 HTTP 响应的 Set-Cookie 续期，合并进 cookies.json。
 * - 仅接受微博相关域；
 * - 跳过删除指令（登出/风控响应会下发空值或已过期条目，吸收它们会清掉有效登录）；
 * - 与现有 Cookie 按 domain+name 合并，有实际变化才落盘（图片代理调用频繁）。
 * @param {string[]} setCookieLines 响应头 set-cookie 数组
 * @param {string} requestUrl 发起请求的 URL（提供默认 domain）
 * @returns {{ok: boolean, changed: number}}
 */
function absorbSetCookies(setCookieLines, requestUrl, reason = 'Set-Cookie 续期') {
    if (!Array.isArray(setCookieLines) || setCookieLines.length === 0) return { ok: true, changed: 0 };
    let requestHost = '';
    try { requestHost = new URL(requestUrl).hostname; } catch { /* 无效 URL 则依赖 Domain 属性 */ }

    const incoming = [];
    for (const line of setCookieLines) {
        const c = parseSetCookie(line, requestHost);
        if (c && !isDeletionCookie(c)) incoming.push(c);
    }
    if (!incoming.length) return { ok: true, changed: 0 };

    const existing = loadCookies();
    normalizeDomains(existing);
    normalizeDomains(incoming);

    let changed = 0;
    for (const c of incoming) {
        const cur = existing.find(e => e && e.name === c.name && e.domain === c.domain);
        if (cur) {
            if (cur.value !== c.value || cur.expires !== c.expires) {
                cur.value = c.value;
                cur.expires = c.expires;
                cur.session = c.session;
                changed++;
            }
        } else {
            existing.push(c);
            changed++;
        }
    }
    if (!changed) return { ok: true, changed: 0 };

    const r = saveCookies(existing, `${reason}，更新 ${changed} 项`);
    return { ok: r.ok, changed: r.ok ? changed : 0 };
}

module.exports = { COOKIE_FILE, loadCookies, saveCookies, hasLoginCookie, normalizeDomains, cookieHeader, filterWeiboCookies, parseSetCookie, absorbSetCookies };
