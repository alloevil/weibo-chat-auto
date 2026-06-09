// 纯文本处理工具：消息内容的转义、emoji、@提及、URL、噪声判定等。
// 同时支持 Node（require）与浏览器（<script src> 后挂到 window）。
// 不依赖 DOM / window，便于单元测试。
(function (root, factory) {
    const api = factory();
    if (typeof module !== 'undefined' && module.exports) {
        module.exports = api; // Node / 测试
    } else {
        Object.assign(root, api); // 浏览器：挂到 window
    }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
    'use strict';

    const EMOJI_MAP = {
        '[笑cry]': '😂', '[允悲]': '😅', '[doge]': '🐶', '[流鼻血]': '😳',
        '[哈哈]': '😆', '[二哈]': '🐕', '[苦涩]': '😩', '[泪]': '😢',
        '[嘻嘻]': '😊', '[太开心]': '😆', '[捂嘴哭]': '🥹', '[怒]': '😡',
        '[流汗]': '😅', '[赞]': '👍', '[并不简单]': '🧐', '[泪奔]': '😭',
        '[努力]': '😤', '[awsl]': '😍', '[哇]': '🤩', '[good]': '👍',
        '[思考]': '🤔', '[打call]': '📣', '[疑问]': '❓', '[单身狗]': '🐕‍🦺',
        '[抱一抱]': '🤗', '[喵喵]': '🐱', '[傻眼]': '😳', '[挖鼻]': '🫣',
        '[爱你]': '💕', '[鼓掌]': '👏', '[加油]': '💪', '[黑线]': '😑',
        '[害羞]': '😳', '[无聊]': '😴', '[打脸]': '😬', '[偷笑]': '🤭',
        '[裂开]': '💔', '[挤眼]': '😜', '[送花花]': '💐', '[亲亲]': '😘',
        '[握手]': '🤝', '[衰]': '😞', '[揣手]': '😳', '[坏笑]': '😏',
        '[酷]': '😎', '[点赞]': '👍', '[可爱]': '🥰', '[皱眉]': '😟',
        '[祈祷]': '🙏', '[伤心]': '😭', '[心]': '❤️', '[憧憬]': '🤩',
        '[摊手]': '🤷', '[费解]': '🫤', '[可怜]': '🥺', '[吃惊]': '😱',
        '[哼]': '😤', '[晕]': '😵', '[开心]': '😊', '[抓狂]': '🤯',
        '[委屈]': '😞', '[嘘]': '🤫', '[阴险]': '😈', '[困]': '😴',
        '[馋嘴]': '🤤', '[睡觉]': '😴', '[失望]': '😔', '[鄙视]': '😒',
        '[生病]': '🤒', '[感冒]': '🤧', '[拜拜]': '👋',
        '[左哼哼]': '😤', '[右哼哼]': '😤', '[怒骂]': '🤬',
        '[哆啦A梦吃惊]': '😱', '[哆啦A梦害怕]': '😨', '[哆啦A梦微笑]': '😊',
        '[柯基]': '🐶', '[吹风车]': '🎐', '[开学季]': '📚',
        '[吃馕]': '🫓', '[春游家族]': '🌸', '[好运连连]': '🍀',
        '[不愧是你]': '👏', '[手指比心]': '🤌', '[老师爱你]': '💗',
        '[11]': '⚡', '[动画表情]': '🎭',
    };

    // 噪声判定用的正则
    const NOISE_RE = /^[早\s~～！!。.·:：?？,，…💗❤️💕🥰😘✨🌟⭐💫🌞☀️🌅👍🤝💪🫶]+$/;
    const DOTS_RE = /^[。.·…,，·\s]+$/;

    function escapeHtml(s) {
        return String(s == null ? '' : s)
            .replace(/&/g, '&amp;').replace(/</g, '&lt;')
            .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
    }

    function escapeAttr(s) {
        return String(s == null ? '' : s)
            .replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/'/g, '&#39;')
            .replace(/</g, '&lt;').replace(/>/g, '&gt;');
    }

    function processEmoji(text) {
        return text.replace(/\[[^\]]+\]/g, (match) => {
            if (EMOJI_MAP[match]) return `<span class="emoji">${EMOJI_MAP[match]}</span>`;
            return `<span class="emoji-unknown">${match}</span>`;
        });
    }

    // @ 提及高亮（在已转义的 HTML 上操作；用前导边界避免误伤标签属性/邮箱）
    function processMentions(html) {
        return html.replace(/(^|[\s　>])@([一-龥A-Za-z0-9_-]{1,30})/g,
            (_m, pre, name) => `${pre}<span class="mention">@${name}</span>`);
    }

    // 引用跳转用：规范化内容取前缀作为匹配键
    function normForQuote(s) {
        return (s || '').replace(/[\s​　]+/g, '').slice(0, 30);
    }

    // 时段分段
    function periodOf(ts) {
        const h = new Date(ts).getHours();
        if (h < 6) return { key: 'dawn', label: '凌晨' };
        if (h < 12) return { key: 'morning', label: '上午' };
        if (h < 18) return { key: 'afternoon', label: '下午' };
        return { key: 'evening', label: '晚上' };
    }

    // URL 转链接，图片 URL 渲染为缩略图
    function processUrls(text) {
        return text.replace(/(https?:\/\/[^\s<]+)/g, (url) => {
            const safeUrl = url.replace(/&/g, '&amp;').replace(/"/g, '&quot;')
                .replace(/'/g, '&#39;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
            const display = url.length > 60 ? url.substring(0, 57) + '...' : url;
            const link = `<a href="${safeUrl}" target="_blank" rel="noopener" class="msg-link">${display}</a>`;
            if (/\.(jpg|jpeg|png|gif|webp)$/i.test(url)) {
                return link + `<br><img src="${safeUrl}" loading="lazy" class="msg-img">`;
            }
            return link;
        });
    }

    function highlightText(text, query) {
        if (!query) return text;
        const escaped = query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const regex = new RegExp(`(${escaped})`, 'gi');
        return text.replace(regex, '<span class="search-highlight">$1</span>');
    }

    // 噪声判定：问候语、纯标点、红包系统消息
    function isNoise(m) {
        const c = ((m && m.content) || '').trim();
        if (NOISE_RE.test(c)) return true;
        if (DOTS_RE.test(c)) return true;
        if (c.includes('收到红包消息')) return true;
        if (c.includes('领取了') && c.includes('的红包')) return true;
        if (c.includes('最佳手气')) return true;
        if (/^\d+\.\d+元，@/.test(c)) return true;
        return false;
    }

    return {
        EMOJI_MAP, NOISE_RE, DOTS_RE,
        escapeHtml, escapeAttr, processEmoji, processMentions,
        normForQuote, periodOf, processUrls, highlightText, isNoise,
    };
});
