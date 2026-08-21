// 归档器注入页面的 hook 脚本（#16）：拦截 webim 的 fetch/XHR 响应,
// 把群消息标准化后暂存在 window.__ARCHIVER_STATE__ 供 Node 侧收取。
//
// normalizeMessage 的实现源只有 lib/normalize-message.js 一份：页内无法
// require()，这里在构建脚本时把 createNormalizeMessage 的函数源码
// （fn.toString()，工厂自包含、不引用外层绑定）拼进脚本运行时求值。
// 曾经的手抄内联副本已因漂移出过事故 —— 副本缺 p.large?.url 分支，
// 页内 hook 捕到的这类图片消息全部丢 pics。
'use strict';

const { createNormalizeMessage } = require('./normalize-message');

/** 生成注入页面的完整脚本（IIFE 字符串）。 */
function buildPageScript() {
    return String.raw`
(function() {
    'use strict';
    const MSG_API_REGEX = new RegExp('/webim/groupchat/query_messages\\.json');
    let messages = [];
    let messageIds = new Set();
    window.__ARCHIVER_STATE__ = {
        messages: [],
        lastGroupId: null,
        getCount: () => messages.length,
        getMessages: () => messages,
        reset: () => { messages = []; messageIds = new Set(); window.__ARCHIVER_STATE__.messages = []; },
        resetGroupId: () => { window.__ARCHIVER_STATE__.lastGroupId = null; },
    };

    // 与 lib/day-file 逐字符一致的本地时间格式（零填充、不依赖 ICU）——
    // 旧版页内用 toLocaleString('zh-CN')，正是三来源格式漂移的源头之一。
    const p2 = n => String(n).padStart(2, '0');
    function formatDate(ts) {
        const d = new Date(ts);
        return d.getFullYear() + '-' + p2(d.getMonth() + 1) + '-' + p2(d.getDate());
    }
    function formatTime(ts) {
        const d = new Date(ts);
        return d.getFullYear() + '/' + p2(d.getMonth() + 1) + '/' + p2(d.getDate()) + ' '
            + p2(d.getHours()) + ':' + p2(d.getMinutes()) + ':' + p2(d.getSeconds());
    }

    // === 单一实现源：以下函数源码来自 lib/normalize-message.js ===
    const createNormalizeMessage = ${createNormalizeMessage.toString()};
    const normalizeMessage = createNormalizeMessage({ formatDate, formatTime });

    function handleApiResponse(data) {
        const msgs = data.messages || data.data?.messages || data.data || [];
        const msgList = Array.isArray(msgs) ? msgs : (Array.isArray(data.list) ? data.list : []);
        let added = 0;
        for (const m of msgList) {
            const n = normalizeMessage(m);
            if (n && !messageIds.has(String(n.id))) {
                messageIds.add(String(n.id));
                messages.push(n);
                window.__ARCHIVER_STATE__.messages.push(n);
                added++;
            }
        }
        if (added > 0) {
            messages.sort((a, b) => a.timestamp - b.timestamp);
            window.__ARCHIVER_STATE__.messages.sort((a, b) => a.timestamp - b.timestamp);
            console.log('[Archiver] 新增 ' + added + ' 条，总计 ' + messages.length);
        }
    }

    const origFetch = window.fetch;
    window.fetch = async function (...args) {
        const resp = await origFetch.apply(this, args);
        try {
            let url = typeof args[0] === 'string' ? args[0] : args[0]?.url || '';
            if (url && MSG_API_REGEX.test(url)) {
                const idMatch = url.match(/[?&]id=(\d+)/);
                if (idMatch) window.__ARCHIVER_STATE__.lastGroupId = idMatch[1];
                resp.clone().json().then(handleApiResponse).catch(() => {});
            }
        } catch {}
        return resp;
    };

    const origOpen = XMLHttpRequest.prototype.open;
    XMLHttpRequest.prototype.open = function (m, url, ...r) { this._url = url; return origOpen.apply(this, [m, url, ...r]); };
    const origSend = XMLHttpRequest.prototype.send;
    XMLHttpRequest.prototype.send = function (...a) {
        this.addEventListener('load', function () {
            try {
                const url = this._url || this.responseURL || '';
                if (url && MSG_API_REGEX.test(url)) {
                    const idMatch = url.match(/[?&]id=(\d+)/);
                    if (idMatch) window.__ARCHIVER_STATE__.lastGroupId = idMatch[1];
                    handleApiResponse(JSON.parse(this.responseText));
                }
            } catch {}
        });
        return origSend.apply(this, a);
    };
    console.log('[Archiver] 脚本已注入');
})();
`;
}

module.exports = { buildPageScript };
