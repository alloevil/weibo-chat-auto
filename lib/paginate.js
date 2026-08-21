// 归档器的分页状态机（#16）：从 scripts/auto-archive-simple.js 的 main()
// 机械搬运，行为不变。依赖全部参数注入（fetchPage / normalize / 时钟 /
// sleep / 日志），因此可以脱离 Puppeteer 做注入式测试 —— 与 lib/live-sync
// 的模块形态对齐。
//
// 核心不变量：分页从新到旧倒着走，只有"到达截止时间"或"没有更多消息"
// 才算走完（paginationComplete=true）；请求失败、接口 error_code、撞上
// MAX_PAGES 都是残缺。调用方（main）只在走完时才推进 state —— 残缺时推进
// 会在断点与上次截止时间之间留下永远补不回来的空洞。
'use strict';

const DEFAULT_MAX_PAGES = 500;
const DEFAULT_PAGE_SIZE = 20;
const DEFAULT_PAGE_DELAY_MS = 300;

/**
 * 拉取一个群的全部新消息（新→旧分页，直到截止时间/无更多消息/出错）。
 *
 * @param {object} deps
 * @param {string|number} deps.groupId 会话 id
 * @param {number} deps.stopTimestamp 截止时间戳（毫秒；0 = 不设截止）
 * @param {(url: string) => Promise<{status: number, data: object}>} deps.fetchPage
 *        单页请求（重试/退避在实现内部处理，见 main 的 fetchPage）
 * @param {(m: object) => object|null} deps.normalize 消息标准化（lib/normalize-message）
 * @param {() => number} [deps.now] 时钟（URL 的 t 参数与缺 time 消息的兜底时间戳）
 * @param {(ms: number) => Promise<void>} [deps.sleep] 页间限速
 * @param {(line: string) => void} [deps.log] 进度日志（输出契约见 lib/sync-report）
 * @param {(batch: object[], info: {pageNum: number}) => void} [deps.onPage]
 *        每页新增消息的回调（落盘等副作用由调用方注入；归档器在整轮结束后统一落盘）
 * @param {number} [deps.maxPages]
 * @param {number} [deps.pageSize]
 * @param {number} [deps.pageDelayMs]
 * @returns {Promise<{messages: object[], paginationComplete: boolean, paginationNote: string}>}
 */
async function paginateMessages({
    groupId,
    stopTimestamp,
    fetchPage,
    normalize,
    now = Date.now,
    sleep = ms => new Promise(r => setTimeout(r, ms)),
    log = console.log,
    onPage = null,
    maxPages = DEFAULT_MAX_PAGES,
    pageSize = DEFAULT_PAGE_SIZE,
    pageDelayMs = DEFAULT_PAGE_DELAY_MS,
}) {
    const messages = [];
    const messageIds = new Set();
    let maxMid = null;
    let pageNum = 0;
    let paginationComplete = false;
    let paginationNote = '';

    while (pageNum < maxPages) {
        let url = `https://api.weibo.com/webim/groupchat/query_messages.json?convert_emoji=1&query_sender=1&count=${pageSize}&id=${groupId}&max_mid=${maxMid || 0}`;
        url += `&source=209678993&t=${now()}`;

        let status, data;
        try {
            ({ status, data } = await fetchPage(url));
        } catch (e) {
            paginationNote = `请求失败: ${e.message}`;
            log(`[API] 重试也失败: ${e.message}`);
            break;
        }

        if (pageNum === 0) {
            log(`[API] 状态: ${status}, keys: ${Object.keys(data).join(',')}`);
        }
        // 接口用 error_code 表达失败，HTTP 一律 200，且失败响应没有 messages。
        // 不单独识别就会被下面当成"无更多消息" → 标记分页走完 → 0 条也算成功，
        // 整轮以退出码 0 收场（"群不存在"、限流都会这样静默空跑）。
        if (data.error_code) {
            paginationNote = `接口错误 ${data.error_code}: ${data.error || ''}`;
            log(`[API] ${paginationNote}`);
            break;
        }

        const rawMsgs = data.messages || data.data?.messages || data.data || [];
        const msgList = Array.isArray(rawMsgs) ? rawMsgs : (Array.isArray(data.list) ? data.list : []);

        if (msgList.length === 0) {
            log('[API] 无更多消息');
            paginationComplete = true;
            break;
        }

        let added = 0;
        const batch = [];
        for (const m of msgList) {
            const n = normalize(m);
            if (n && !messageIds.has(String(n.id))) {
                messageIds.add(String(n.id));
                messages.push(n);
                batch.push(n);
                added++;
            }
        }
        if (onPage && batch.length > 0) onPage(batch, { pageNum });

        const firstMsg = msgList[0];
        const firstId = String(firstMsg?.id || firstMsg?.mid || '');

        // 时间截止
        const pageOldestTs = (typeof firstMsg?.time === 'number' && firstMsg.time > 0) ? firstMsg.time * 1000 : now();
        if (stopTimestamp > 0 && pageOldestTs < stopTimestamp) {
            log(`[API] 到达截止时间，停止 (消息时间=${new Date(pageOldestTs).toLocaleString('zh-CN')})`);
            paginationComplete = true;
            break;
        }

        if (pageNum % 10 === 0) {
            log(`[API] 第${pageNum + 1}页: +${added} 总=${messages.length}`);
        }

        if (!firstId || firstId === maxMid) {
            log('[API] 分页结束');
            paginationComplete = true;
            break;
        }
        maxMid = firstId;
        pageNum++;

        await sleep(pageDelayMs);
    }

    if (!paginationComplete && !paginationNote) {
        paginationNote = `撞上 MAX_PAGES=${maxPages} 上限`;
    }

    return { messages, paginationComplete, paginationNote };
}

module.exports = { paginateMessages, DEFAULT_MAX_PAGES, DEFAULT_PAGE_SIZE };
