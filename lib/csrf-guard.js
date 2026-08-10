// 跨站写操作拦截。
//
// 查看器只绑 127.0.0.1，但"只监听本机"防不住 CSRF：用户浏览任意网页时，
// 那个页面可以用 <form action="http://127.0.0.1:3456/api/send" method=POST
// enctype="text/plain"> 发出一个"简单请求"（无需 CORS 预检），而 text/plain
// 的 body 可以精心构造成合法 JSON（name=value 里的 = 落在字符串里）。
// 实测确认可利用：伪造 Origin 的 text/plain 请求成功改掉了实时同步开关。
//
// 可被这样触发的写操作包括：/api/send（以用户身份往群里发消息）、
// /api/ai-config（改 baseUrl/apiKey → 后续摘要与问答把聊天内容发往攻击者）、
// /api/live-config、/api/schedule、/api/sync、/api/request-login。
//
// 判据用 Origin + Sec-Fetch-Site：跨站 form POST 浏览器**必带** Origin，
// 攻击页无法抹掉它；而 curl、Tauri 的 Rust 侧轮询这类非浏览器调用没有 Origin，
// 不该被拦。因此规则是"有 Origin 就必须是本机"，而不是"必须有 Origin"。
'use strict';

const LOCAL_HOSTS = new Set(['127.0.0.1', 'localhost', '::1', '[::1]']);

/**
 * 该请求是否为跨站发起（应拒绝的写操作）。
 * @param {object} headers Node 的 req.headers（键为小写）
 * @returns {boolean}
 */
function isCrossSiteRequest(headers = {}) {
    // Sec-Fetch-Site 是浏览器自己打的标记，攻击页改不了：
    // same-origin / none（地址栏直接访问、非浏览器）放行，其余（cross-site、
    // same-site）拒绝。
    const site = headers['sec-fetch-site'];
    if (site && site !== 'same-origin' && site !== 'none') return true;

    const origin = headers.origin;
    if (!origin || origin === 'null') {
        // 没有 Origin：curl / Tauri Rust 侧 / 同源 GET。跨站 form POST 一定带
        // Origin，所以这里放行不会给攻击者留门。
        return false;
    }
    try {
        return !LOCAL_HOSTS.has(new URL(origin).hostname);
    } catch {
        return true;   // Origin 畸形 → 当跨站处理
    }
}

module.exports = { isCrossSiteRequest, LOCAL_HOSTS };
