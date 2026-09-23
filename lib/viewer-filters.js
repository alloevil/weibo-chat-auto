// 查看器消息筛选的纯逻辑；Node 单测与浏览器共用。
(function (root, factory) {
    const api = factory();
    if (typeof module !== 'undefined' && module.exports) module.exports = api;
    else Object.assign(root, api);
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
    'use strict';

    function filterViewerMessages(
        messages,
        {
            date,
            hours = new Set(),
            users = new Set(),
            mediaFilter = 'all',
            hideNoise = false,
            mentionOnly = false,
            isNoise = () => false,
            mentionsMe = () => false,
        } = {}
    ) {
        return (Array.isArray(messages) ? messages : []).filter((message) => {
            if (message.date !== date) return false;
            if (hours.size > 0 && !hours.has(new Date(message.timestamp).getHours())) return false;
            if (users.size > 0 && !users.has(message.user)) return false;
            if (mediaFilter === 'pics' && (!message.pics || message.pics.length === 0))
                return false;
            if (
                mediaFilter === 'video' &&
                !message.videoUrl &&
                message.content !== '分享视频' &&
                message.content !== 'Video'
            )
                return false;
            if (mediaFilter === 'link' && !message.link && !message.share && !message.videoUrl)
                return false;
            if (hideNoise && isNoise(message)) return false;
            // @我 永远排噪声，不能依赖用户是否另外打开了「隐藏噪声」。
            if (mentionOnly && (!mentionsMe(message) || isNoise(message))) return false;
            return true;
        });
    }

    return { filterViewerMessages };
});
