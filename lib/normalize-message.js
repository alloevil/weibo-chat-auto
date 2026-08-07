// 微博消息标准化：原始 API 响应 → 统一消息格式。
//
// 归档器的 Node 分页与查看器的实时轮询（lib/live-sync.js）共用此实现 ——
// 两条通路必须产出逐字段一致的记录，否则同一条消息会因来源不同而重复入库
// 或字段缺失。时间字段一律走 lib/day-file 的格式化器（本地时区、零填充）。
//
// 注入到页面里的 hook 无法 require()，那侧保留内联副本。
'use strict';

const { formatLocalDate, formatLocalTime } = require('./day-file');

/**
 * 从微博 API 消息对象提取标准化字段。
 * @param {object} m 原始消息
 * @returns {object|null} 标准化消息；无 id 时返回 null
 */
function normalizeMessage(m) {
    const id = m?.id || m?.mid || m?.message_id || null;
    if (!id) return null;
    const ts = (typeof m.time === 'number' && m.time > 0) ? m.time * 1000 :
        (m.created_at ? Date.parse(m.created_at) : Date.now());
    const fromUser = m.from_user || {};

    // 提取图片 URL
    const pics = [];
    if (m.pic_urls && Array.isArray(m.pic_urls)) {
        m.pic_urls.forEach(p => {
            const u = p.url || p.pic || p.large?.url || (typeof p === 'string' ? p : null);
            if (u) pics.push(u.replace(/^http:/, 'https:'));
        });
    }
    if (pics.length === 0 && m.pic) {
        pics.push(String(m.pic).replace(/^http:/, 'https:'));
    }

    // 从 fids 构建图片 URL（media_type=1 的图片消息）
    if (pics.length === 0 && m.fids && Array.isArray(m.fids)) {
        m.fids.forEach(fid => {
            pics.push('https://upload.api.weibo.com/2/mss/msget?source=209678993&fid=' + fid);
        });
    }

    // 提取分享内容（url_objects，media_type=14 时有值）
    let shareInfo = null;
    if (m.url_objects && m.url_objects.length > 0) {
        const uo = m.url_objects[0];
        const info = uo.info || {};
        const status = uo.status || {};
        const statusUser = status.user || {};
        const picIds = status.pic_ids || [];
        const picUrls = picIds.map(pid => `https://wx1.sinaimg.cn/large/${pid}.jpg`);

        shareInfo = {
            url: uo.url_ori || info.url_long || info.url_short || '',
            title: info.title || (status.text || '').substring(0, 100),
            description: info.description || '',
            author: statusUser.screen_name || '',
            authorAvatar: statusUser.avatar_hd || statusUser.avatar_large || '',
            text: (status.text || '').replace(/<[^>]+>/g, '').replace(/[\r\n]+/g, ' ').substring(0, 300),
            pics: picUrls,
            reposts: status.reposts_count || 0,
            comments: status.comments_count || 0,
            likes: status.attitudes_count || 0,
            region: status.region_name || '',
            created: status.created_at || '',
        };
    }

    // 提取附加 URL
    let extraUrl = '';
    if (m.url) extraUrl = String(m.url).replace(/^http:/, 'https:');
    if (!extraUrl && m.short_url) extraUrl = String(m.short_url).replace(/^http:/, 'https:');

    // 从 url_objects 提取流媒体 URL（视频消息）
    let videoUrl = '';
    if (m.url_objects && m.url_objects.length > 0) {
        const uo = m.url_objects[0];
        const info = uo.info || {};
        videoUrl = info.video_url || info.url_short || info.url_long || uo.url_ori || '';
        videoUrl = videoUrl.replace(/^http:/, 'https:');
    }

    const result = {
        id,
        from_uid: m.from_uid || fromUser.id || fromUser.idstr || null,
        user: fromUser.screen_name || fromUser.name || m.from_uid || '未知用户',
        avatar: fromUser.avatar_large || fromUser.avatar_hd || fromUser.profile_image_url || '',
        timestamp: ts,
        time: formatLocalTime(ts),
        date: formatLocalDate(ts),
        content: (m.content ?? m.text ?? m.message ?? m.body ?? '').replace(/[\r\n]+/g, ' ').replace(/\s+/g, ' ').trim(),
        type: m.type || m.msg_type || 'text',
    };

    // 只在有值时添加额外字段
    if (pics.length > 0) result.pics = pics;
    if (shareInfo) result.share = shareInfo;
    if (extraUrl && !result.content.includes(extraUrl)) result.link = extraUrl;
    if (videoUrl) result.videoUrl = videoUrl;

    return result;
}

module.exports = { normalizeMessage };
