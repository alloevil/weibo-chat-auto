// /api/messages 响应路径的图片 URL 改写（#15）。
//
// loadMessages 返回的是进程内缓存里的同一批对象，改写必须发生在副本上：
// 就地改写会把缓存永久污染成代理 URL，后续所有消费者（导出、QA agent、
// 通知、统计）都得记得做逆变换 —— export-chat 曾为此打过 originalPicUrl
// 逆变换补丁（已随本修复删除）。
//
// 返回新数组 + 新消息对象 + 新 pics 数组；缓存里永远是原始 sinaimg URL。

'use strict';

/**
 * @param {Array<object>} messages 缓存里的消息（不被修改）
 * @returns {Array<object>} pics/share.pics 换成本地代理路径的浅拷贝
 */
function rewriteImageUrls(messages) {
    return messages.map(m => {
        let out = m;
        if (m.pics) {
            out = {
                ...m,
                pics: m.pics.map(u => {
                    const fidMatch = u.match(/fid=(\d+)/);
                    return fidMatch ? `/api/image?fid=${fidMatch[1]}` : u;
                }),
            };
        }
        if (m.share && m.share.pics) {
            if (out === m) out = { ...m };
            out.share = {
                ...m.share,
                pics: m.share.pics.map(u =>
                    u.includes('sinaimg.cn') ? `/api/sinaimg?url=${encodeURIComponent(u)}` : u,
                ),
            };
        }
        return out;
    });
}

module.exports = { rewriteImageUrls };
