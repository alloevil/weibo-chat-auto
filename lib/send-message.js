// 群聊发消息：POST /webim/groupchat/send_message.json（form-urlencoded）。
//
// 端点与参数是从 webim 前端 bundle 读出、再用不存在的群 id 探测确认的：
//   · 缺 id            → error_code 21297 "invalid parameter: id is required!"
//   · id=0 + content   → error_code 21201 "群不存在"（说明参数已被接受）
//   · Cookie 失效      → error_code 21301（与其它 webim 接口一致）
// 微博用 result:false + error_code 表达失败，HTTP 状态码一律 200 ——
// 只看 resp.ok 会把每个失败都当成功，这里必须解析 body。
//
// annotations 与 return_detail 不是可选装饰：真实 web 客户端每次发送都带
// annotations={"webchat":1,"clientid":…}（clientid 来自 comet 长连接，未连
// 接时它自己也发空串）。少了这个客户端标记，接口会回 result:true，但消息
// 随即被风控撤回 —— 群里只留下一条"你撤回了一条消息"，实测踩过。
// return_detail=1 让响应带回已创建的消息对象，投递与否可确定性判断，
// 不必靠"没有 error_code 就算成功"猜。
'use strict';

const API_ORIGIN = 'https://api.weibo.com';
const SEND_PATH = '/webim/groupchat/send_message.json';
const MAX_CONTENT = 2000;

const UNAUTHENTICATED_CODE = 21301;
const GROUP_NOT_FOUND_CODE = 21201;

/**
 * 发一条群聊文本消息。
 * @returns {{ok: boolean, needLogin?: boolean, error?: string, code?: number, raw?: object}}
 */
async function sendGroupMessage({ groupId, content, cookieHeader, fetchImpl = fetch, timeoutMs = 15000 }) {
    const text = typeof content === 'string' ? content.trim() : '';
    if (!groupId) return { ok: false, error: '缺少群会话 id（需先跑一次归档让它被记录）' };
    if (!text) return { ok: false, error: '消息内容为空' };
    if (text.length > MAX_CONTENT) return { ok: false, error: `消息过长（${text.length} > ${MAX_CONTENT}）` };

    const body = new URLSearchParams({
        source: '209678993',
        id: String(groupId),
        content: text,
        media_type: '0',
        annotations: JSON.stringify({ webchat: 1, clientid: '' }),
        return_detail: '1',
    }).toString();

    const resp = await fetchImpl(API_ORIGIN + SEND_PATH, {
        method: 'POST',
        headers: {
            Cookie: cookieHeader,
            Referer: `${API_ORIGIN}/chat`,
            'X-Requested-With': 'XMLHttpRequest',
            'Content-Type': 'application/x-www-form-urlencoded',
            'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36',
        },
        body,
        signal: AbortSignal.timeout(timeoutMs),
    });

    let data;
    try {
        data = await resp.json();
    } catch {
        return { ok: false, error: `响应无法解析（HTTP ${resp.status}）` };
    }

    const code = data.error_code || 0;
    if (code === UNAUTHENTICATED_CODE) {
        return { ok: false, needLogin: true, code, error: '微博 Cookie 已失效，请重新扫码登录' };
    }
    if (code === GROUP_NOT_FOUND_CODE) {
        return { ok: false, code, error: '群不存在或已退出（会话 id 可能过期，跑一次归档可刷新）' };
    }
    // result:false / 任意 error_code 都是失败：HTTP 200 不代表发出去了
    if (code || data.result === false) {
        return { ok: false, code, error: data.error || `发送失败（error_code ${code}）` };
    }
    // return_detail=1 时成功响应带回已创建的消息对象；透出 id 供日志/排错
    // （不把"必须有 id"当成功判据：没实测过微博在何种成功下会省略 detail）
    return { ok: true, messageId: data.id ? String(data.id) : null, raw: data };
}

module.exports = { sendGroupMessage, MAX_CONTENT, SEND_PATH, UNAUTHENTICATED_CODE, GROUP_NOT_FOUND_CODE };
