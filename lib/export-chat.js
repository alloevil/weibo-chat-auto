// 导出渲染：按天消息 → Markdown / 自包含 HTML。
// 服务端静态渲染，复用 lib/text-utils 的转义/表情/噪声规则；
// 引用解析与查看器 processForward 同一套「」+ 分隔线协议。
'use strict';

const { escapeHtml, processEmoji, normForQuote, isNoise } = require('./text-utils');

// 微博转发消息的固定分隔线（与 viewer.html processForward 一致）
const SEP = ' - - - - - - - - - - - - - - - ';

/**
 * 拆出引用与回复（查看器 parseQuote 的服务端版）。
 * @returns {{quote: string|null, reply: string}}
 */
function parseForward(s) {
    s = s == null ? '' : String(s);
    if (!s.includes(SEP)) return { quote: null, reply: s };

    // 找最外层的「」配对
    const firstOpen = s.indexOf('「');
    if (firstOpen !== 0) {
        const idx = s.indexOf(SEP);
        return { quote: s.substring(0, idx), reply: s.substring(idx + SEP.length) };
    }

    // 找配对的 」（引用内容可嵌套「」）
    let depth = 0, closeIdx = -1;
    for (let i = 0; i < s.length; i++) {
        if (s[i] === '「') depth++;
        else if (s[i] === '」') { depth--; if (depth === 0) { closeIdx = i; break; } }
    }
    if (closeIdx === -1) {
        const idx = s.indexOf(SEP);
        if (idx === -1) return { quote: null, reply: s };
        return { quote: s.substring(0, idx), reply: s.substring(idx + SEP.length) };
    }

    const quote = s.substring(1, closeIdx); // 去掉「」
    const rest = s.substring(closeIdx + 1);
    const sepIdx = rest.indexOf(SEP);
    if (sepIdx !== -1) return { quote, reply: rest.substring(sepIdx + SEP.length) };
    return { quote, reply: rest.trim() };
}

// 引用归属：内容前缀 → 原作者（与查看器 __contentIndex 同一规则）
function buildContentIndex(messages) {
    const index = {};
    for (const m of messages) {
        const key = normForQuote(m && m.content);
        if (key && !(key in index)) index[key] = { id: m.id, user: m.user };
    }
    return index;
}

function quoteAuthor(quote, index) {
    if (quote.trim() === '微博') return '微博';
    const hit = index[normForQuote(quote)];
    return hit && hit.user ? String(hit.user) : '';
}

function hhmm(m) {
    const t = ((m && m.time) || '').split(' ')[1] || '';
    return t.slice(0, 5);
}

/** 默认过滤红包/噪音（keepNoise=true 关闭），与查看器规则一致。 */
function filterMessages(messages, { keepNoise = false } = {}) {
    return keepNoise ? messages : messages.filter(m => !isNoise(m));
}

/**
 * Markdown 导出：[HH:MM] 昵称: 消息；引用为 blockquote 带原作者；
 * 表情保留 [label] 文本；图片输出原始 URL。
 */
function renderMarkdown(messages, { group = '', date = '' } = {}) {
    const lines = [`# ${group || '微博群聊'} ${date}`.trim(), ''];
    const index = buildContentIndex(messages);

    for (const m of messages) {
        const time = hhmm(m);
        const user = String(m.user || '');
        const { quote, reply } = parseForward(m.content);

        if (quote !== null) {
            const author = quoteAuthor(quote, index);
            lines.push(`[${time}] ${user}:`);
            const qlines = quote.split('\n');
            lines.push(`> ${author ? `${author}：` : ''}${qlines[0]}`);
            for (const ql of qlines.slice(1)) lines.push(`> ${ql}`);
            if (reply) { lines.push(''); lines.push(reply); }
        } else {
            const clines = String(m.content || '').split('\n');
            lines.push(`[${time}] ${user}: ${clines[0]}`);
            for (const cl of clines.slice(1)) lines.push(cl);
        }

        // 缓存不再被 /api/messages 污染（#15），pics 即原始 URL，直接输出
        for (const pic of m.pics || []) lines.push(`![图片](${pic})`);
        if (m.share && m.share.url) lines.push(`> 分享：[${m.share.title || m.share.url}](${m.share.url})`);
        lines.push('');
    }
    return lines.join('\n');
}

// 自包含 HTML 的内联样式：从查看器消息样式（.msg-*/.forward-quote）取
// 关键规则并换成固定配色 —— 导出文件没有主题变量。无外部 CSS/JS 引用。
const HTML_STYLE = `
body { font-family: -apple-system, "PingFang SC", "Microsoft YaHei", sans-serif; background: #f6f7f8; color: #1a1a1a; max-width: 760px; margin: 0 auto; padding: 24px 16px 48px; }
h1 { font-size: 20px; } .export-meta { color: #8a8f94; font-size: 13px; margin-bottom: 20px; }
.msg-item { margin: 14px 0; }
.msg-user { font-size: 14px; font-weight: 600; }
.msg-time { font-size: 12px; color: #8a8f94; margin-left: 6px; font-variant-numeric: tabular-nums; }
.msg-content { display: inline-block; max-width: 100%; padding: 8px 12px; border: 1px solid #e2e5e8; border-radius: 10px; background: #fff; font-size: 15px; line-height: 1.5; word-break: break-word; overflow-wrap: anywhere; margin-top: 4px; }
.forward-quote { border-left: 3px solid #ff8200; margin: 4px 0 6px; padding: 8px 12px; background: #f2f3f5; border-radius: 0 6px 6px 0; font-size: 14px; color: #555; line-height: 1.45; }
.quote-author { font-weight: 600; color: #d96c00; }
.forward-reply { margin-top: 2px; }
.emoji-unknown { display: inline-block; padding: 1px 5px; margin: 0 1px; border-radius: 4px; background: #ececec; color: #888; font-size: 12px; vertical-align: middle; }
.msg-pics img { max-width: 280px; max-height: 320px; border-radius: 8px; margin-top: 6px; display: block; }
.msg-link { color: #d96c00; word-break: break-all; }
`.trim();

/**
 * 自包含 HTML 导出：内联 CSS、无外部引用，断网可打开。
 * 表情走内置 Unicode 表，未命中保留 [label]；图片保留原始 URL。
 */
function renderHtml(messages, { group = '', date = '' } = {}) {
    const index = buildContentIndex(messages);
    // 与查看器一致的处理链，去掉网络依赖：escape → emoji(仅内置表)
    const pipe = (s) => processEmoji(escapeHtml(s)).replace(/\n/g, '<br>');
    const items = [];

    for (const m of messages) {
        const { quote, reply } = parseForward(m.content);
        let body;
        if (quote !== null) {
            const author = quoteAuthor(quote, index);
            const authorTag = author ? `<span class="quote-author">${escapeHtml(author)}：</span>` : '';
            body = `<div class="forward-quote">${authorTag}${pipe(quote)}</div>`
                + `<div class="forward-reply">${pipe(reply)}</div>`;
        } else {
            body = pipe(m.content || '');
        }

        let attach = '';
        if (m.pics && m.pics.length > 0) {
            attach += '<div class="msg-pics">' + m.pics.map(u => {
                const orig = escapeHtml(String(u || ''));
                return `<a href="${orig}"><img src="${orig}" alt="图片" loading="lazy"></a>`;
            }).join('') + '</div>';
        }
        if (m.share && m.share.url) {
            attach += `<div><a class="msg-link" href="${escapeHtml(m.share.url)}">${escapeHtml(m.share.title || m.share.url)}</a></div>`;
        }

        items.push(`<div class="msg-item">
    <span class="msg-user">${escapeHtml(m.user)}</span><span class="msg-time">${escapeHtml(hhmm(m))}</span>
    <div class="msg-content">${body}${attach}</div>
</div>`);
    }

    const title = escapeHtml(`${group || '微博群聊'} ${date}`.trim());
    return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title}</title>
<style>
${HTML_STYLE}
</style>
</head>
<body>
<h1>${title}</h1>
<div class="export-meta">共 ${messages.length} 条消息 · 由 weibo-chat-auto 导出</div>
${items.join('\n')}
</body>
</html>
`;
}

module.exports = { parseForward, buildContentIndex, filterMessages, renderMarkdown, renderHtml };
