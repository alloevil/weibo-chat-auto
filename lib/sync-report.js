// 归档器输出 → /api/sync 响应与进度条的唯一解析处。
// 归档器的打印格式就是这里的输入契约：格式一变，只改这里和对应测试。
//
// v1.11.0 起的硬约定：Cookie 失效、有群被跳过都以非 0 退出码收场，
// 所以 exit 0 即全部群归档成功，不再从输出里猜"是否其实失败了"
// （旧标志串如"已保存到:"归档器已不再打印，靠它计数会把成功报成 0 个群）。
'use strict';

/**
 * 归档器进程结束 → HTTP 响应体。
 * @param {number} code 进程退出码
 * @param {string} out stdout + stderr 合并输出
 * @returns {{ok: boolean, needLogin?: boolean, error?: string, archived?: number, skipped?: number}}
 */
function buildSyncResult(code, out) {
    if (code !== 0) {
        // Cookie 失效有明确输出（归档器 exit 1），直接引导重新扫码
        if (out.includes('Cookie 已失效')) {
            return { ok: false, needLogin: true, error: '微博 Cookie 已失效，请重新扫码登录' };
        }
        // 归档器兜底打印 "错误: <Error 类名>: <原因>"（如 "2/3 个群未归档: …"）。
        // 重试过程会打印多条，取最后一条 —— 那才是压垮本轮的真实原因
        const reasons = out.match(/错误: \w*Error: [^\n]+/g);
        const reason = reasons
            ? reasons[reasons.length - 1].replace(/^错误: \w*Error: /, '')
            : `归档器异常退出（code ${code}）`;
        return { ok: false, error: reason };
    }
    const archived = (out.match(/--- 归档群聊:/g) || []).length;
    return { ok: true, archived, skipped: 0 };
}

/** 从归档器输出的一行更新进度对象（/api/sync-progress 轮询用）。原地修改。 */
function updateProgress(progress, line) {
    const m = line.match(/--- 归档群聊: (.+?) ---/);
    if (m) {
        progress.current += 1;
        progress.stage = `正在归档「${m[1].trim()}」（${progress.current}/${progress.total || '?'}）`;
    } else if (line.includes('目标群聊:')) {
        progress.total = (line.split(':')[1] || '').split(',').length;
    } else if (line.includes('打开微博聊天页面')) {
        progress.stage = '打开微博聊天页…';
    } else if (line.includes('API 分页获取完成')) {
        progress.stage = progress.stage.replace(/（/, '完成（');
    }
}

module.exports = { buildSyncResult, updateProgress };
