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

const UNAUTHENTICATED_CODE = 21301;
const PROBE_PATH = '/webim/groupchat/query_messages.json'
    + '?convert_emoji=1&query_sender=1&count=1&id=0&max_mid=0&source=209678993';

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

module.exports = { UNAUTHENTICATED_CODE, PROBE_PATH, probeAuthCode, isAuthenticated, waitForAuth };
