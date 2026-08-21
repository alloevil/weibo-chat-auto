// 每日摘要（#19）：归档调度、摘要生成、通知管线三者都已存在，这里只做编排。
//
// 触发模型：不监听归档进程（定时归档在另一个进程里跑，viewer 可能不在场），
// 而是周期性检查条件链 —— 开关开 → AI 已配 → 过了摘要时点 → 归档器不在跑
// → 当日有消息 → 今天还没做过。全链任一不满足即静默跳过：默认关（与
// live-sync 同一哲学，关闭时零额外行为），未配 AI 完全不打扰。
//
// 依赖全部注入（配置/AI 探测/消息计数/摘要生成/通知/状态存取），
// 摘要生成由调用方绑定到 /api/summary 的自请求 —— 复用同一条生成路径
// （含缓存与 vision 两步），这里不复制任何 LLM 代码。
'use strict';

const DEFAULT_HOUR = 20;              // 晚 8 点后首次满足条件时生成「当日摘要」
const FAIL_RETRY_MS = 30 * 60 * 1000; // 生成失败后同群 30 分钟内不重试（防抖 AI API）

/** 摘要正文 → 通知 body：去 markdown 记号，取前几行压成一段。 */
function digestExcerpt(summary, limit = 140) {
    return String(summary || '')
        .replace(/[#*`>]/g, '')
        .split('\n')
        .map(s => s.trim())
        .filter(Boolean)
        .join(' · ')
        .slice(0, limit);
}

/**
 * @param {object} deps
 * @param {() => {enabled:boolean, hour?:number}} deps.getConfig 摘要开关与时点（默认关）
 * @param {() => boolean} deps.hasAiConfig AI 是否配置完整（baseUrl/apiKey/model）
 * @param {() => string[]} deps.listGroups 有归档数据的群名列表
 * @param {(group:string, date:string) => number} deps.countMessages 某群某日消息数
 * @param {(group:string, date:string) => Promise<{ok:boolean, summary?:string, error?:string}>} deps.generateSummary
 * @param {(group:string, notifications:object[]) => void} deps.notify 通知投递（SSE 广播）
 * @param {() => boolean} [deps.isArchiverRunning] 归档器是否在跑（跑完再摘要，别摘半截）
 * @param {() => object} deps.loadState 去重状态 { digested: { 群名: 'YYYY-MM-DD' } }
 * @param {(state:object) => void} deps.saveState
 * @param {() => Date} [deps.nowDate] 本地时间源（可注入便于测试）
 * @param {(msg:string) => void} [deps.log]
 */
function createDailyDigest({
    getConfig,
    hasAiConfig,
    listGroups,
    countMessages,
    generateSummary,
    notify,
    isArchiverRunning = () => false,
    loadState,
    saveState,
    nowDate = () => new Date(),
    log = () => {},
}) {
    let running = false;
    const lastFail = new Map(); // group → 失败时刻（内存即可，重启后重试无害）

    const p2 = n => String(n).padStart(2, '0');

    async function check() {
        if (running) return { skipped: 'busy' };
        running = true;
        try {
            const cfg = getConfig() || {};
            if (cfg.enabled !== true) return { skipped: 'disabled' };
            if (!hasAiConfig()) return { skipped: 'no-ai' };

            const d = nowDate();
            const hour = Number.isInteger(cfg.hour) ? cfg.hour : DEFAULT_HOUR;
            if (d.getHours() < hour) return { skipped: 'too-early' };
            if (isArchiverRunning()) return { skipped: 'archiving' };

            const date = `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())}`;
            const state = loadState() || {};
            if (!state.digested || typeof state.digested !== 'object') state.digested = {};

            const generated = [];
            for (const group of listGroups()) {
                if (state.digested[group] === date) continue;               // 今天已做过
                if (d.getTime() - (lastFail.get(group) || 0) < FAIL_RETRY_MS) continue;
                if (countMessages(group, date) === 0) continue;             // 当日无消息不打扰

                const r = await generateSummary(group, date);
                if (!r || r.ok !== true || !r.summary) {
                    lastFail.set(group, d.getTime());
                    log(`[digest] 「${group}」${date} 摘要生成失败：${r?.error || '未知错误'}（30 分钟后重试）`);
                    continue;
                }
                state.digested[group] = date;
                saveState(state);   // 先落状态再通知：宁可漏一条通知，不可重复打扰
                notify(group, [{
                    kind: 'summary',
                    group,
                    date,
                    title: `「${group}」今日摘要`,
                    body: digestExcerpt(r.summary),
                }]);
                generated.push(group);
                log(`[digest] 「${group}」${date} 每日摘要已生成并通知`);
            }
            return { generated };
        } finally {
            running = false;
        }
    }

    return { check };
}

module.exports = { createDailyDigest, digestExcerpt, DEFAULT_HOUR, FAIL_RETRY_MS };
