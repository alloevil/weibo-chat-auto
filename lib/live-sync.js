// 实时同步：查看器常驻期间轮询 webim 接口，把新消息并入日文件并推给前端。
//
// 为什么不用浏览器：归档器靠 puppeteer 点击是为了解析群会话 id；一旦 id 已知，
// 拉消息就是纯 HTTP（api.weibo.com 同域带 Cookie 即可）。所以实时同步复用
// 归档器写在 state 里的 groupId，全程无浏览器、无 Chrome 进程。
//
// 硬约定（与归档器一致，破坏其一即数据不一致）：
//   · 标准化只走 lib/normalize-message（字段必须与归档结果逐一致，否则同一条
//     消息会因来源不同而重复入库或缺字段）
//   · 落盘只走 lib/day-file.mergeIntoDayFile（原子写、按 id 去重、损坏备份）
//   · 首轮只建游标不广播 —— 否则订阅者一连上就把整页历史当"新消息"收一遍
'use strict';

const path = require('path');
const { mergeIntoDayFile } = require('./day-file');
const { normalizeMessage } = require('./normalize-message');
const { UNAUTHENTICATED_CODE } = require('./weibo-auth');

const DEFAULT_INTERVAL_MS = 20000;
const PAGE_COUNT = 20;          // 单页条数（与归档器一致）
// 一轮最多往回翻几页。固定只拉最近 20 条会在突发时丢消息：实测「茧房建筑师
// 协会」有 67 个 20 秒窗口超过 20 条（峰值 28），那些落在窗口更早位置的消息
// 永远进不了广播，只能等下次全量归档补。现在改成"翻到与已见集重叠为止"，
// 上限 5 页（100 条/轮）足以覆盖实测峰值，同时防止异常情况下无限翻页。
const MAX_BACKFILL_PAGES = 5;
const SEEN_LIMIT = 400;         // 每群保留的已见 id 上限（防无界增长）
const API_ORIGIN = 'https://api.weibo.com';

/** 拉一页最近消息（不含分页），返回标准化结果与接口错误码。 */
async function fetchRecent({ groupId, cookieHeader, count = PAGE_COUNT, maxMid = 0, fetchImpl = fetch, timeoutMs = 15000 }) {
    const url = `${API_ORIGIN}/webim/groupchat/query_messages.json`
        + `?convert_emoji=1&query_sender=1&count=${count}&id=${groupId}&max_mid=${maxMid}`
        + `&source=209678993&t=${Date.now()}`;
    const resp = await fetchImpl(url, {
        headers: {
            Cookie: cookieHeader,
            Referer: `${API_ORIGIN}/chat`,
            'X-Requested-With': 'XMLHttpRequest',
            'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36',
        },
        signal: AbortSignal.timeout(timeoutMs),
    });
    const data = await resp.json();
    const errorCode = data.error_code || 0;
    const raw = Array.isArray(data.messages) ? data.messages : [];
    const messages = raw.map(normalizeMessage).filter(Boolean)
        .sort((a, b) => a.timestamp - b.timestamp);
    return { errorCode, messages };
}

/** 把消息按 date 分组（跨日界的一轮增量要落进各自的日文件）。 */
function groupByDate(messages) {
    const byDate = new Map();
    for (const m of messages) {
        const d = m.date || 'unknown';
        if (!byDate.has(d)) byDate.set(d, []);
        byDate.get(d).push(m);
    }
    return byDate;
}

/**
 * 单群一轮：拉取 → 过滤已见 → 落盘 → 返回新消息。
 * 游标（seen）由调用方持有，首轮（primed=false）只建游标不返回新消息。
 *
 * @returns {{status:'ok'|'primed'|'unauthenticated', newMessages: object[], dates: string[]}}
 */
async function pollGroupOnce(group, deps) {
    const collected = [];
    // 本轮已收集的 id：group.seen 要等整轮结束才更新，光靠它过滤的话，接口若
    // 忽略 max_mid（或两页有重叠）就会把同一条消息在一轮内收集两次。
    const roundIds = new Set();
    let maxMid = 0;
    let caughtUp = false;
    let truncated = false;

    // 往回翻页直到这一页出现"已见过"的消息 —— 那说明已经追上游标，中间没有缺口。
    for (let page = 0; page < MAX_BACKFILL_PAGES; page++) {
        const { errorCode, messages } = await fetchRecent({
            groupId: group.groupId,
            cookieHeader: deps.cookieHeader(),
            fetchImpl: deps.fetchImpl,
            maxMid,
        });
        if (errorCode === UNAUTHENTICATED_CODE) {
            return { status: 'unauthenticated', newMessages: [], dates: [] };
        }
        if (messages.length === 0) { caughtUp = true; break; }

        const fresh = messages.filter(m => !group.seen.has(String(m.id)) && !roundIds.has(String(m.id)));
        for (const m of fresh) roundIds.add(String(m.id));
        collected.push(...fresh);

        // 整页都是本轮已收过的（接口忽略了 max_mid）→ 再翻也是同一页
        if (fresh.length === 0) { caughtUp = true; break; }

        // 这一页里有已见过的消息 → 追上了
        if (fresh.length < messages.length) { caughtUp = true; break; }
        // 首轮没有游标可比对，本来只为建游标，翻一页就够
        if (!group.primed) { caughtUp = true; break; }

        // 整页都是新的：更老的可能还没拿到，继续往回翻（max_mid 用本页最老一条）
        const oldest = String(messages[0].id);
        if (oldest === String(maxMid)) { caughtUp = true; break; }   // 游标没推进，防死循环
        maxMid = oldest;
        if (page === MAX_BACKFILL_PAGES - 1) truncated = true;
    }

    for (const m of collected) group.seen.add(String(m.id));
    // 有界裁剪：Set 保序，砍掉最早进来的
    if (group.seen.size > SEEN_LIMIT) {
        const excess = group.seen.size - SEEN_LIMIT;
        let i = 0;
        for (const id of group.seen) {
            if (i++ >= excess) break;
            group.seen.delete(id);
        }
    }

    if (!group.primed) {
        group.primed = true;
        return { status: 'primed', newMessages: [], dates: [] };
    }
    if (collected.length === 0) return { status: 'ok', newMessages: [], dates: [], caughtUp };

    const fresh = collected.sort((a, b) => a.timestamp - b.timestamp);
    const dates = [];
    for (const [date, msgs] of groupByDate(fresh)) {
        mergeIntoDayFile(path.join(group.dir, `weibo_chat_${date}.json`), msgs);
        dates.push(date);
    }
    // truncated：撞上回补上限，更老的增量留给下次全量归档补
    return { status: 'ok', newMessages: fresh, dates, caughtUp, truncated };
}

/**
 * 实时同步器。订阅者出现时启动轮询、全部离开后停止（没人看时不打接口）。
 *
 * @param {object} opts
 * @param {() => Array<{name:string, groupId:string, dir:string}>} opts.resolveGroups 每次启动时解析群列表（groupId 缺失的群由调用方过滤）
 * @param {() => string} opts.cookieHeader Cookie 头取值函数（登录态会变，不能快照）
 * @param {(event:object) => void} opts.emit 事件回调：{type:'messages'|'auth'|'error', ...}
 * @param {() => boolean} [opts.isEnabled] 总闸门。关闭时一个请求都不发 ——
 *   轮询会读取群消息，而微博侧的已读游标（query_messages 返回的 last_read_mid）
 *   是否被读取推进无法从外部证伪，所以必须允许用户彻底关掉，保住原生客户端
 *   的未读提示。每轮都重新求值，切换开关无需重启。
 */
function createLiveSync({ resolveGroups, cookieHeader, emit, intervalMs = DEFAULT_INTERVAL_MS, fetchImpl = fetch, log = () => {}, isEnabled = () => true }) {
    const state = new Map();   // name → { groupId, dir, seen, primed }
    let timer = null;
    let subscribers = 0;
    let polling = null;   // 进行中那一轮的 promise（null = 空闲）

    function groupsForPoll() {
        const out = [];
        for (const g of resolveGroups()) {
            if (!g.groupId) continue;   // 归档器还没记下会话 id，该群跳过
            let s = state.get(g.name);
            // groupId 变了（换群/重新解析）就重建游标，避免拿旧会话的已见集过滤
            if (!s || s.groupId !== g.groupId) {
                s = { groupId: g.groupId, dir: g.dir, seen: new Set(), primed: false };
                state.set(g.name, s);
            }
            s.dir = g.dir;
            out.push({ name: g.name, ...s });
        }
        return out;
    }

    async function runRound() {
        for (const g of groupsForPoll()) {
            try {
                const r = await pollGroupOnce(g, { cookieHeader, fetchImpl });
                if (r.status === 'unauthenticated') {
                    // Cookie 失效后继续轮询只是空转；停掉并让前端弹扫码
                    log('[live] 登录态失效，停止实时同步');
                    emit({ type: 'auth', ok: false });
                    stop();
                    return;
                }
                if (r.newMessages.length > 0) {
                    log(`[live] ${g.name}: +${r.newMessages.length} 条`);
                    emit({ type: 'messages', group: g.name, dates: r.dates, messages: r.newMessages });
                }
            } catch (e) {
                // 单群失败不影响其它群，也不推进游标：下轮自然补回
                emit({ type: 'error', group: g.name, error: e.message });
            }
        }
    }

    /**
     * 跑一轮。已有轮次在飞时返回那一轮的 promise —— 绝不并发打同一个接口，
     * 同时让调用方（含定时器与测试）能 await "当前这一轮"，而不是拿到 undefined
     * 以为没在跑。
     */
    function tick() {
        if (!isEnabled()) return Promise.resolve();   // 关闭时连一个请求都不发
        if (polling) return polling;
        polling = runRound().finally(() => { polling = null; });
        return polling;
    }

    function start() {
        if (timer || !isEnabled()) return;
        timer = setInterval(tick, intervalMs);
        timer.unref?.();
        tick();
    }

    function stop() {
        if (!timer) return;
        clearInterval(timer);
        timer = null;
    }

    return {
        /** 新订阅者接入；首个订阅者触发轮询启动（开关关闭时不启动）。 */
        addSubscriber() { subscribers += 1; if (subscribers === 1) start(); },
        /** 订阅者离开；最后一个离开则停止轮询。 */
        removeSubscriber() { subscribers = Math.max(0, subscribers - 1); if (subscribers === 0) stop(); },
        /** 开关切换后重新对齐轮询状态（开启且有订阅者才跑）。 */
        refresh() { if (isEnabled() && subscribers > 0) start(); else stop(); },
        get subscribers() { return subscribers; },
        get running() { return timer !== null; },
        tick,
        stop,
    };
}

module.exports = { createLiveSync, pollGroupOnce, fetchRecent, groupByDate, DEFAULT_INTERVAL_MS, PAGE_COUNT, MAX_BACKFILL_PAGES, SEEN_LIMIT };
