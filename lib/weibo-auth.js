// 微博登录态的唯一判据：webim 接口返回的 error_code。
// 21301 = 未鉴权 / Cookie 失效（"Auth failed, Cookie expires or invalid."）；
// 其它业务错误码（如 21201 群不存在）说明鉴权已经过了。
//
// 绝不用 DOM 文案/元素猜测。带失效 Cookie 打开 api.weibo.com/chat 时 URL、
// 标题、#app、[class*=chat] 与登录态完全一致，正文长度也不稳定。这类判据在
// v1.10.x 之前同时坑了三处：
//   · auto-archive-simple.js 的 waitForLogin 用 querySelector('#app')，
//     Cookie 过期后 3 秒即误报"检测到已登录"，归档器带着失效 Cookie 跑完
//     全程、连续多日产出 0 条并以退出码 0 收场；
//   · save-cookies.js / lib/browser-login.js 的 alreadyLoggedIn 写成
//     innerText.substring(0, 200) 再判 length > 200，恒为 false。
'use strict';

const cookieStore = require('./cookie-store');

const UNAUTHENTICATED_CODE = 21301;
const PROBE_PATH = '/webim/groupchat/query_messages.json'
    + '?convert_emoji=1&query_sender=1&count=1&id=0&max_mid=0&source=209678993';
const PROBE_ORIGIN = 'https://api.weibo.com';

/** 在页面上下文探测鉴权状态，返回接口 error_code（0 表示响应里没有错误码）。 */
async function probeAuthCode(page) {
    return await page.evaluate(async (url) => {
        const resp = await fetch(url, { credentials: 'include' });
        const data = await resp.json();
        return data.error_code || 0;
    }, PROBE_PATH);
}

/** 是否已鉴权。探测本身失败时返回 null，由调用方决定退回启发式还是重试。 */
async function isAuthenticated(page) {
    try {
        return (await probeAuthCode(page)) !== UNAUTHENTICATED_CODE;
    } catch {
        return null;
    }
}

/** 轮询等待鉴权通过（扫码登录用）。超时返回 false。 */
async function waitForAuth(page, { timeoutMs = 600000, intervalMs = 3000 } = {}) {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
        if ((await isAuthenticated(page)) === true) return true;
        if (Date.now() + intervalMs >= deadline) return false;
        await new Promise(r => setTimeout(r, intervalMs));
    }
}

/**
 * HTTP 层探测（不依赖浏览器页面）：给 viewer-server 这类拿不到 page 的调用方。
 * 探测失败（断网/超时/非 JSON）向上抛，由调用方决定拦路还是放行。
 */
async function probeAuthCodeHttp(cookieHeader, { timeoutMs = 8000 } = {}) {
    const resp = await fetch(PROBE_ORIGIN + PROBE_PATH, {
        headers: { Cookie: cookieHeader, Referer: PROBE_ORIGIN + '/chat' },
        signal: AbortSignal.timeout(timeoutMs),
    });
    const data = await resp.json();
    return data.error_code || 0;
}

// 会话续期端点与浏览器 UA：api.weibo.com 的响应从不下发 Set-Cookie，
// 唯一可续的是 weibo.com 侧的 24 小时滚动会话（WBPSESS + XSRF-TOKEN），
// 服务端把 webim 登录态与它绑在一起 —— 只归档不保活，次日即 21301。
const RENEWAL_URL = 'https://weibo.com/ajax/profile/info?custom=1';
const BROWSER_UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36'
    + ' (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

/**
 * 会话保活：先按 webim error_code 验明登录态，再打一发 weibo.com/ajax
 * 吸收滚动续期。未登录时绝不吸收 —— 死会话下 weibo.com 会派发游客
 * Cookie（visitor SUB 等），吸进 cookies.json 会污染真实登录态。
 * 探测/续期请求自身失败（断网、超时）向上抛，由调用方决定重试节奏。
 * @returns {{ok: boolean, code: number, renewed: number}}
 */
async function refreshSession({ timeoutMs = 10000 } = {}) {
    const header = cookieStore.cookieHeader();
    const code = await probeAuthCodeHttp(header, { timeoutMs });
    if (code === UNAUTHENTICATED_CODE) return { ok: false, code, renewed: 0 };

    const resp = await fetch(RENEWAL_URL, {
        headers: { Cookie: header, 'User-Agent': BROWSER_UA, Referer: 'https://weibo.com/' },
        redirect: 'manual',
        signal: AbortSignal.timeout(timeoutMs),
    });
    const { changed } = cookieStore.absorbSetCookies(resp.headers.getSetCookie(), RENEWAL_URL, '会话保活');
    return { ok: true, code, renewed: changed };
}

module.exports = { UNAUTHENTICATED_CODE, PROBE_PATH, probeAuthCode, probeAuthCodeHttp, isAuthenticated, waitForAuth, refreshSession };
