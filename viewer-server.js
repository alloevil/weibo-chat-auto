const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const { exec } = require('child_process');

const PORT = process.env.WEIBO_PORT ? Number(process.env.WEIBO_PORT) : 3456;
const OUTPUT_DIR = process.env.WEIBO_OUTPUT_DIR
    ? path.resolve(process.env.WEIBO_OUTPUT_DIR)
    : path.join(__dirname, 'output');

process.on('uncaughtException', (err) => {
    console.error('[uncaughtException]', err.message);
});
process.on('unhandledRejection', (err) => {
    console.error('[unhandledRejection]', err);
});

function loadCookies() {
    // cookie-store 是 cookies.json 的唯一读写入口（fs/path 依赖，Bun 可打包）
    return require('./lib/cookie-store').cookieHeader();
}

// 微博响应会滚动续期部分 Cookie（Set-Cookie），吸收回 cookies.json 延长登录有效期
function absorbSetCookies(proxyRes, requestUrl) {
    const sc = proxyRes.headers['set-cookie'];
    if (!sc || !sc.length) return;
    try {
        require('./lib/cookie-store').absorbSetCookies(sc, requestUrl);
    } catch (e) {
        console.error('[cookie] Set-Cookie 吸收失败:', e.message);
    }
}

// 消息加载与缓存统一走 lib/load-messages（eval/索引脚本共用同一实现）
const messageStore = require('./lib/load-messages');
// 登录态预检与归档器共用同一判据（接口 error_code，见 lib/weibo-auth）
const weiboAuth = require('./lib/weibo-auth');
// 归档器输出 → 同步结果/进度 的解析规则统一在 lib/sync-report（有对应单测）
const syncReport = require('./lib/sync-report');
// 实时同步（lib/live-sync）：查看器常驻期间轮询 webim，把新消息并入日文件并
// 通过 SSE 推给页面。只在有订阅者时轮询，没人看不打接口。
const { createLiveSync, DEFAULT_INTERVAL_MS: LIVE_INTERVAL_MS } = require('./lib/live-sync');
// 发消息（写操作）统一走 lib/send-message：微博失败也回 HTTP 200，必须解析 body
const { sendGroupMessage } = require('./lib/send-message');
// 跨站写操作拦截（CSRF）：只绑 127.0.0.1 不足以防护，见 lib/csrf-guard
const { isCrossSiteRequest } = require('./lib/csrf-guard');
// 图片缓存治理：cache/images 是纯优化（内容可再取），此前无淘汰策略涨到 688MB
const { evictCache, isCacheable } = require('./lib/cache-store');
// 定时归档任务的发现/解析（按程序路径认领，不硬编码 label）见 lib/launch-agents
const { findArchiveAgents, describeSchedule } = require('./lib/launch-agents');
// 表情清单：内置 Unicode 表只覆盖 83%，其余靠微博官方清单渲染成图片
const { loadEmotions } = require('./lib/emotions');

/** 群名 → 归档器写在 state 里的会话 id（缺失表示该群还没被归档器解析过）。 */
function readGroupState(groupName) {
    const safe = groupName.replace(/[^a-zA-Z0-9一-鿿]/g, '_');
    try {
        return JSON.parse(fs.readFileSync(path.join(__dirname, 'state', `last-archive-state_${safe}.json`), 'utf-8'));
    } catch {
        return null;
    }
}

/** 可实时同步的群：output/ 下有数据且 state 里有 groupId。 */
function resolveLiveGroups() {
    const out = [];
    if (!fs.existsSync(OUTPUT_DIR)) return out;
    for (const entry of fs.readdirSync(OUTPUT_DIR, { withFileTypes: true })) {
        if (!entry.isDirectory()) continue;
        const st = readGroupState(entry.name);
        if (!st?.groupId) continue;
        out.push({ name: entry.name, groupId: String(st.groupId), dir: path.join(OUTPUT_DIR, entry.name) });
    }
    return out;
}
// 实时同步总开关。**默认关闭**：轮询会读取群消息，而"读取是否会推进微博侧的
// 已读游标"无法从外部证伪（query_messages 的响应自带 last_read_mid，只能通过
// 同一个接口观察它）。默认开着就有可能悄悄吃掉原生客户端的未读提示 ——
// 这种代价必须由用户显式选择承担，而不是默认替他决定。
// 持久化在 live-config.json（与 ai-config.json 同套路，不去改用户手写的 config.json）。
const LIVE_CONFIG_PATH = path.join(__dirname, 'live-config.json');
function readLiveEnabled() {
    try {
        return JSON.parse(fs.readFileSync(LIVE_CONFIG_PATH, 'utf-8')).enabled === true;
    } catch {
        return false;   // 文件缺失/损坏 → 关闭（保守侧）
    }
}
function writeLiveEnabled(enabled) {
    fs.writeFileSync(LIVE_CONFIG_PATH, JSON.stringify({ enabled: !!enabled }, null, 2), 'utf-8');
}
let liveEnabled = readLiveEnabled();

const sseClients = new Set();
function broadcast(event) {
    const payload = `data: ${JSON.stringify(event)}\n\n`;
    for (const res of sseClients) {
        try { res.write(payload); } catch { sseClients.delete(res); }
    }
}

// 轮询错误对用户是静默的（网络抖动不该弹提示），但完全不落日志就等于
// 实时同步哑掉了也查不出来。同一群同一错误 5 分钟内只记一次，避免刷屏。
const liveErrorSeen = new Map();
function logLiveError(group, error) {
    const key = `${group}:${error}`;
    const now = Date.now();
    if (now - (liveErrorSeen.get(key) || 0) < 300000) return;
    liveErrorSeen.set(key, now);
    console.error(`[live] ${group} 轮询失败: ${error}`);
}

const liveSync = createLiveSync({
    resolveGroups: resolveLiveGroups,
    cookieHeader: loadCookies,
    isEnabled: () => liveEnabled,
    log: (m) => console.log(m),
    emit: (event) => {
        if (event.type === 'messages') {
            // 缓存必须先失效：前端收到事件后会重新拉 /api/messages，
            // 不清缓存会拿到不含新消息的旧快照
            messageStore.clearCaches();
            authState.ok = true;
        } else if (event.type === 'auth' && event.ok === false) {
            authState.ok = false;
            authState.code = weiboAuth.UNAUTHENTICATED_CODE;
            authState.checkedAt = Date.now();
        } else if (event.type === 'error') {
            logLiveError(event.group, event.error);
        }
        broadcast(event);
    },
});

// —— 会话保活 ——
// api.weibo.com 的响应从不下发 Set-Cookie，而服务端把 webim 登录态与
// weibo.com 的 24 小时滚动会话（WBPSESS）绑在一起：只归档不保活，一天后
// 就 21301（2026-07-29 起"扫码→活一天→再死"即此因）。viewer 常驻期间
// 每 30 分钟续一次期，结果存 authState 供 /api/auth-status 查询。
const authState = { ok: null, code: 0, checkedAt: 0, renewedTotal: 0, error: '' };
async function keepAliveTick(reason = '定时') {
    try {
        const r = await weiboAuth.refreshSession();
        const wasDead = authState.ok === false;
        authState.ok = r.ok;
        authState.code = r.code;
        authState.error = '';
        if (r.renewed) {
            authState.renewedTotal += r.renewed;
            console.log(`[keepalive] 会话续期 ${r.renewed} 项（${reason}）`);
        }
        if (!r.ok && !wasDead) console.error('[keepalive] 微博登录态已失效（21301），需要重新扫码');
    } catch (e) {
        authState.error = e.message; // 网络失败不改判登录态，只记录
    }
    authState.checkedAt = Date.now();
}
setInterval(keepAliveTick, 30 * 60 * 1000).unref();

function getGroupDir(groupName) {
    return messageStore.getGroupDir(OUTPUT_DIR, groupName);
}

function loadMessages(groupName = '') {
    return messageStore.loadMessages(OUTPUT_DIR, groupName);
}

function loadMessagesByDate(groupName = '', date = '') {
    return messageStore.loadMessagesByDate(OUTPUT_DIR, groupName, date);
}

function rewriteImageUrls(messages) {
    for (const m of messages) {
        if (m.pics) {
            m.pics = m.pics.map(u => {
                // Skip if already rewritten
                if (u.startsWith('/api/image?fid=') || u.startsWith('/api/sinaimg?')) return u;
                const fidMatch = u.match(/fid=(\d+)/);
                return fidMatch ? `/api/image?fid=${fidMatch[1]}` : u;
            });
        }
        if (m.share && m.share.pics) {
            m.share.pics = m.share.pics.map(u => {
                // Skip if already rewritten
                if (u.startsWith('/api/sinaimg?')) return u;
                if (u.includes('sinaimg.cn')) {
                    return `/api/sinaimg?url=${encodeURIComponent(u)}`;
                }
                return u;
            });
        }
    }
}

const CACHE_DIR = path.join(__dirname, 'cache', 'images');
if (!fs.existsSync(CACHE_DIR)) fs.mkdirSync(CACHE_DIR, { recursive: true });

// Reusable LLM API caller (OpenAI-compatible)
function callLlmApi(messages, callback) {
    let aiConfig;
    try {
        aiConfig = JSON.parse(fs.readFileSync(path.join(__dirname, 'ai-config.json'), 'utf-8'));
    } catch { callback(null, 'AI 未配置'); return; }
    const reqBody = JSON.stringify({ model: aiConfig.model, messages });
    const apiUrl = new URL(aiConfig.baseUrl.replace(/\/$/, '') + '/chat/completions');
    const isHttps = apiUrl.protocol === 'https:';
    const httpModule = isHttps ? https : http;
    const options = {
        hostname: apiUrl.hostname,
        port: apiUrl.port || (isHttps ? 443 : 80),
        path: apiUrl.pathname + apiUrl.search,
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${aiConfig.apiKey}` },
        agent: false,
    };
    const llmReq = httpModule.request(options, (llmRes) => {
        const chunks = [];
        llmRes.on('data', chunk => chunks.push(chunk));
        llmRes.on('end', () => {
            const body = Buffer.concat(chunks).toString();
            try {
                const data = JSON.parse(body);
                if (data.error) { callback(null, data.error.message || JSON.stringify(data.error)); return; }
                callback(data.choices?.[0]?.message?.content || '');
            } catch (e) { callback(null, '解析失败: ' + e.message); }
        });
    });
    llmReq.on('error', (e) => callback(null, '请求失败: ' + e.message));
    llmReq.setTimeout(90000, () => { llmReq.destroy(); callback(null, '请求超时（90s）'); });
    llmReq.end(reqBody);
}

function serveImage(res, filePath, contentType) {
    const stat = fs.statSync(filePath);
    res.writeHead(200, {
        'Content-Type': contentType,
        'Cache-Control': 'public, max-age=86400',
        'Content-Length': stat.size,
    });
    fs.createReadStream(filePath).pipe(res);
}

function qaLegacy(question, allMessages, reply) {
    const today = new Date().toISOString().split('T')[0];
    const extractPrompt = [
        { role: 'system', content: `你是一个搜索查询解析器。今天是 ${today}。根据用户的问题，提取搜索关键词和时间范围。

输出严格JSON格式（不要输出其他内容）：
{"keywords": ["关键词1", "关键词2", ...], "person": "人名或null", "dateFrom": "YYYY-MM-DD或null", "dateTo": "YYYY-MM-DD或null"}

规则：
- keywords: 3-5个最相关的搜索关键词（排除人名和时间词）
- person: 如果问题针对某个人（如"xx说了什么"），提取人名，否则null
- dateFrom/dateTo: 将时间表述转为绝对日期（"昨天"→昨天日期，"最近"→7天前到今天，无时间→null）
- 不要把时间词放入keywords` },
        { role: 'user', content: question }
    ];
    callLlmApi(extractPrompt, (extraction, err) => {
        if (err) { reply({ ok: false, error: '查询解析失败: ' + err }); return; }

        let keywordList, dateFrom, dateTo, person;
        try {
            const parsed = JSON.parse(extraction.replace(/```json?\s*|\s*```/g, '').trim());
            keywordList = parsed.keywords || [];
            dateFrom = parsed.dateFrom || null;
            dateTo = parsed.dateTo || null;
            person = parsed.person || null;
        } catch {
            keywordList = extraction.split(/[,，、\s]+/).filter(k => k.length > 0);
            dateFrom = null; dateTo = null; person = null;
        }

        let messages = allMessages;
        if (dateFrom || dateTo) {
            messages = allMessages.filter(m => {
                const d = (m.time || '').split(' ')[0].replace(/\//g, '-');
                if (!d) return false;
                if (dateFrom && d < dateFrom) return false;
                if (dateTo && d > dateTo) return false;
                return true;
            });
            if (!messages.length) {
                reply({ ok: true, answer: `在 ${dateFrom || '?'} 至 ${dateTo || '?'} 期间未找到聊天记录。`, sources: [], keywords: keywordList });
                return;
            }
        }

        const scored = [];
        for (let i = 0; i < messages.length; i++) {
            const m = messages[i];
            const text = (m.user || '') + ' ' + (m.content || '') + ' ' + (m.share?.title || '');
            let score = 0;
            if (person && (m.user || '').toLowerCase().includes(person.toLowerCase())) score += 3;
            for (const kw of keywordList) {
                if (text.toLowerCase().includes(kw.toLowerCase())) score++;
            }
            if (score > 0) scored.push({ idx: i, score });
        }

        if (!scored.length && (dateFrom || dateTo)) {
            const sample = messages.slice(-50);
            const ctx = sample.map(m => {
                const t = m.time ? m.time.split(' ')[1]?.slice(0, 5) : '';
                const date = m.time ? m.time.split(' ')[0] : '';
                let text = m.content || '';
                if (m.share) text += ` [分享: ${m.share.title || m.share.url || ''}]`;
                return `[${date} ${t}] ${m.user}: ${text}`;
            }).join('\n');
            callLlmApi([
                { role: 'system', content: '你是一个群聊记录问答助手。根据提供的聊天记录回答用户问题。只基于记录回答，不要编造。用简洁的中文回答。' },
                { role: 'user', content: `问题：${question}\n\n以下是 ${dateFrom || '?'} 至 ${dateTo || '?'} 期间的群聊记录：\n\n${ctx.slice(0, 8000)}` }
            ], (answer, ansErr) => {
                if (ansErr) { reply({ ok: false, error: '回答生成失败: ' + ansErr }); return; }
                reply({ ok: true, answer, sources: [{ date: dateFrom || dateTo || '', preview: `${messages.length} 条消息` }], keywords: keywordList, dateRange: { from: dateFrom, to: dateTo } });
            });
            return;
        }

        if (!scored.length) {
            reply({ ok: true, answer: '未找到与该问题相关的聊天记录。请尝试换一种问法或使用更具体的关键词。', sources: [], keywords: keywordList });
            return;
        }

        scored.sort((a, b) => b.score - a.score);
        const topHits = scored.slice(0, 20);
        const segments = new Set();
        const contextChunks = [];
        for (const hit of topHits) {
            const start = Math.max(0, hit.idx - 5);
            const end = Math.min(messages.length, hit.idx + 6);
            const segKey = `${start}-${end}`;
            if (segments.has(segKey)) continue;
            let skip = false;
            for (const existing of segments) {
                const [es, ee] = existing.split('-').map(Number);
                if (start >= es && end <= ee) { skip = true; break; }
            }
            if (skip) continue;
            segments.add(segKey);
            const chunk = messages.slice(start, end).map(m => {
                const t = m.time ? m.time.split(' ')[1]?.slice(0, 5) : '';
                const date = m.time ? m.time.split(' ')[0] : '';
                let text = m.content || '';
                if (m.share) text += ` [分享: ${m.share.title || m.share.url || ''}]`;
                if (m.pics?.length) text += ` [图片x${m.pics.length}]`;
                return `[${date} ${t}] ${m.user}: ${text}`;
            }).join('\n');
            contextChunks.push({ text: chunk, date: (messages[start].time?.split(' ')[0] || '').replace(/\//g, '-'), score: hit.score });
        }

        let totalLen = 0;
        const finalChunks = [];
        for (const c of contextChunks) {
            if (totalLen + c.text.length > 8000) break;
            finalChunks.push(c);
            totalLen += c.text.length;
        }

        const contextText = finalChunks.map((c, i) => `--- 片段 ${i + 1}（${c.date}）---\n${c.text}`).join('\n\n');
        callLlmApi([
            { role: 'system', content: '你是一个群聊记录问答助手。根据提供的聊天记录片段回答用户问题。只基于记录回答，不要编造。引用具体发言人和日期。用简洁的中文回答。' },
            { role: 'user', content: `问题：${question}\n\n以下是相关的群聊记录片段：\n\n${contextText}` }
        ], (answer, ansErr) => {
            if (ansErr) { reply({ ok: false, error: '回答生成失败: ' + ansErr }); return; }
            const sources = finalChunks.map(c => ({ date: c.date, preview: c.text.split('\n').slice(0, 3).join(' | ').slice(0, 100) }));
            reply({ ok: true, answer, sources, keywords: keywordList, dateRange: (dateFrom || dateTo) ? { from: dateFrom, to: dateTo } : undefined });
        });
    });
}

const server = http.createServer((req, res) => {
    const url = new URL(req.url, `http://localhost:${PORT}`);

    // 跨站写操作一律拒绝。只绑 127.0.0.1 挡不住 CSRF：用户浏览的任意网页都能
    // 用 text/plain 的跨站表单打这些端点（实测可利用），从而以用户身份发消息、
    // 或改掉 AI 配置把聊天内容导向攻击者。判据见 lib/csrf-guard（有单测）。
    // /api/summary 是 GET 但会写摘要文件并花 AI 额度，一并纳入。
    const isWrite = req.method === 'POST' || url.pathname === '/api/summary';
    if (isWrite && isCrossSiteRequest(req.headers)) {
        console.error(`[security] 拒绝跨站请求 ${req.method} ${url.pathname} (origin=${req.headers.origin || '-'})`);
        res.writeHead(403, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ ok: false, error: '拒绝跨站请求' }));
        return;
    }

    // List available groups
    if (url.pathname === '/api/groups') {
        const groups = [];
        let lastArchived = 0;
        // Check root output dir (backward compat)
        if (fs.existsSync(OUTPUT_DIR)) {
            const rootFiles = fs.readdirSync(OUTPUT_DIR).filter(f => /^weibo_chat_\d{4}-\d{2}-\d{2}\.json$/.test(f));
            if (rootFiles.length > 0) {
                const latestMtime = rootFiles.reduce((max, f) => {
                    const mt = fs.statSync(path.join(OUTPUT_DIR, f)).mtimeMs;
                    return mt > max ? mt : max;
                }, 0);
                if (latestMtime > lastArchived) lastArchived = latestMtime;
                groups.push({ id: '', name: 'Default', count: rootFiles.length });
            }
            // Check subdirectories
            for (const entry of fs.readdirSync(OUTPUT_DIR, { withFileTypes: true })) {
                if (entry.isDirectory()) {
                    const subDir = path.join(OUTPUT_DIR, entry.name);
                    const files = fs.readdirSync(subDir).filter(f => /^weibo_chat_\d{4}-\d{2}-\d{2}\.json$/.test(f));
                    if (files.length > 0) {
                        const latestMtime = files.reduce((max, f) => {
                            const mt = fs.statSync(path.join(subDir, f)).mtimeMs;
                            return mt > max ? mt : max;
                        }, 0);
                        if (latestMtime > lastArchived) lastArchived = latestMtime;
                        groups.push({ id: entry.name, name: entry.name, count: files.length });
                    }
                }
            }
        }
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ groups, lastArchived }));
        return;
    }

    if (url.pathname === '/api/messages') {
        const group = url.searchParams.get('group') || '';
        const date = url.searchParams.get('date') || '';
        const messages = date ? loadMessagesByDate(group, date) : loadMessages(group);
        rewriteImageUrls(messages);
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ messages }));
        return;
    }

    // Get available dates and message counts
    if (url.pathname === '/api/dates') {
        const group = url.searchParams.get('group') || '';
        const dir = getGroupDir(group);
        const dates = {};
        if (fs.existsSync(dir)) {
            const files = fs.readdirSync(dir)
                .filter(f => /^weibo_chat_\d{4}-\d{2}-\d{2}\.json$/.test(f));
            for (const file of files) {
                const dateMatch = file.match(/weibo_chat_(\d{4}-\d{2}-\d{2})\.json/);
                if (dateMatch) {
                    const date = dateMatch[1];
                    try {
                        const data = JSON.parse(fs.readFileSync(path.join(dir, file), 'utf-8'));
                        const msgs = data.messages || data;
                        dates[date] = Array.isArray(msgs) ? msgs.length : 0;
                    } catch {
                        dates[date] = 0;
                    }
                }
            }
        }
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ dates }));
        return;
    }

    // 发送群聊消息。写操作 —— 与 API 无鉴权、只绑 127.0.0.1 是同一套前提。
    // 成功后立刻催一轮实时同步：自己发的消息走与他人消息完全相同的入库路径，
    // 不在本地伪造回显（两条来源会打架）。
    if (url.pathname === '/api/send' && req.method === 'POST') {
        let body = '';
        // setEncoding 后 Node 用 StringDecoder 保留不完整的多字节序列；
        // 少了它，中文请求体跨 chunk 就会碎成 ���（见 lib/read-stream.js）
        req.setEncoding('utf-8');
        req.on('data', c => { body += c; if (body.length > 1e5) req.destroy(); });
        req.on('end', async () => {
            const reply = (r) => {
                res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
                res.end(JSON.stringify(r));
            };
            let params;
            try { params = JSON.parse(body); } catch { reply({ ok: false, error: '参数解析失败' }); return; }
            const group = params.group || '';
            const target = resolveLiveGroups().find(g => g.name === group);
            if (!target) {
                reply({ ok: false, error: `群「${group}」没有可用的会话 id，先跑一次归档（Sync Now）让它被记录` });
                return;
            }
            try {
                const r = await sendGroupMessage({
                    groupId: target.groupId,
                    content: params.content,
                    cookieHeader: loadCookies(),
                });
                if (r.ok) {
                    console.log(`[send] → ${group}: ${String(params.content).slice(0, 40)} (mid=${r.messageId || '?'})`);
                    // 实时同步关闭时不催轮询：那也是一次读取，会破坏"关掉就
                    // 一个请求都不发"的承诺。此时自己发的消息等下次归档出现。
                    if (liveEnabled) liveSync.tick();
                } else if (r.needLogin) {
                    authState.ok = false;
                    authState.code = weiboAuth.UNAUTHENTICATED_CODE;
                }
                reply(r.ok ? { ok: true } : { ok: false, needLogin: r.needLogin, error: r.error });
            } catch (e) {
                reply({ ok: false, error: `发送请求失败: ${e.message}` });
            }
        });
        return;
    }

    // 实时同步开关（默认关闭）。前端读它决定指示灯与轮询是否开启。
    if (url.pathname === '/api/live-config') {
        if (req.method === 'GET') {
            res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
            res.end(JSON.stringify({ ok: true, enabled: liveEnabled, groups: resolveLiveGroups().map(g => g.name) }));
            return;
        }
        if (req.method === 'POST') {
            let body = '';
            req.setEncoding('utf-8');
            req.on('data', c => { body += c; });
            req.on('end', () => {
                try {
                    const { enabled } = JSON.parse(body);
                    liveEnabled = !!enabled;
                    writeLiveEnabled(liveEnabled);
                    liveSync.refresh();   // 立即生效：开则起轮询，关则停
                    console.log(`[live] 实时同步已${liveEnabled ? '开启' : '关闭'}`);
                    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
                    res.end(JSON.stringify({ ok: true, enabled: liveEnabled }));
                } catch (e) {
                    res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
                    res.end(JSON.stringify({ ok: false, error: e.message }));
                }
            });
            return;
        }
    }

    // 实时同步事件流（SSE）：新消息、登录态失效。首个订阅者触发轮询启动，
    // 最后一个断开即停止（没人看时不打微博接口）。
    if (url.pathname === '/api/live') {
        res.writeHead(200, {
            'Content-Type': 'text/event-stream; charset=utf-8',
            'Cache-Control': 'no-cache',
            Connection: 'keep-alive',
            'X-Accel-Buffering': 'no',
        });
        res.write(`data: ${JSON.stringify({ type: 'hello', enabled: liveEnabled, groups: resolveLiveGroups().map(g => g.name), intervalMs: LIVE_INTERVAL_MS })}\n\n`);
        sseClients.add(res);
        liveSync.addSubscriber();
        // 心跳注释：浏览器与代理都会掐掉长时间静默的连接
        const beat = setInterval(() => { try { res.write(': ping\n\n'); } catch { /* 已断开 */ } }, 25000);
        beat.unref?.();
        const cleanup = () => {
            if (!sseClients.delete(res)) return;   // 只在首次断开时结算订阅数
            clearInterval(beat);
            liveSync.removeSubscriber();
        };
        req.on('close', cleanup);
        req.on('error', cleanup);
        return;
    }

    // 表情清单（标签 → 图片 URL）。磁盘缓存 7 天，网络失败退回旧缓存，
    // 因此前端拿不到映射只会退化成显示 [标签]，不会白屏或报错。
    if (url.pathname === '/api/emotions') {
        loadEmotions(path.join(__dirname, 'cache', 'emotions.json'), { cookieHeader: loadCookies() })
            .then(({ map, source, count }) => {
                if (source === 'network') console.log(`[emotions] 已更新表情清单 ${count} 条`);
                else if (source === 'empty') console.warn('[emotions] 表情清单拉取失败且无缓存，未知表情将显示为文字标签');
                res.writeHead(200, {
                    'Content-Type': 'application/json; charset=utf-8',
                    // 前端每次加载都会取一次；缓存一天避免频繁请求（服务端另有 7 天磁盘缓存）
                    'Cache-Control': 'private, max-age=86400',
                });
                res.end(JSON.stringify({ ok: true, source, count, map }));
            })
            .catch((e) => {
                res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
                res.end(JSON.stringify({ ok: false, error: e.message, map: {} }));
            });
        return;
    }

    // 登录态（服务端 keepalive 每 30 分钟维护；前端轮询，失效即提示扫码）
    if (url.pathname === '/api/auth-status') {
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify(authState));
        return;
    }

    // Sync: trigger archiver
    if (url.pathname === '/api/sync' && req.method === 'POST') {
        (async () => {
        // 预检登录态：Cookie 已死时秒级明确失败并引导重新扫码，而不是让
        // 归档器空跑几分钟后只报一句 "code 1"。探测本身失败（断网、接口
        // 抖动）不拦路 —— 那种情况交给归档器自己判定。
        try {
            const code = await weiboAuth.probeAuthCodeHttp(loadCookies());
            authState.ok = code !== weiboAuth.UNAUTHENTICATED_CODE;
            authState.code = code;
            authState.checkedAt = Date.now();
            if (!authState.ok) {
                res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
                res.end(JSON.stringify({ ok: false, needLogin: true, error: '微博 Cookie 已失效，请重新扫码登录' }));
                return;
            }
        } catch { /* 探测失败不拦路 */ }

        // Invalidate all message caches
        messageStore.clearCaches();
        const isBundled = !process.execPath.endsWith('node') && !process.execPath.endsWith('bun');
        const jsRuntime = isBundled ? 'node' : process.execPath;

        // 进度状态：spawn 增量读 stdout，前端轮询 /api/sync-progress 获取
        const progress = { running: true, stage: '启动归档器…', current: 0, total: 0, startedAt: Date.now() };
        global.__syncProgress = progress;

        const { spawn } = require('child_process');
        const child = spawn(jsRuntime, [path.join(__dirname, 'auto-archive-simple.js')], {
            env: { ...process.env, PATH: process.env.PATH },
        });
        let out = '';
        const timer = setTimeout(() => child.kill('SIGKILL'), 600000);
        const onChunk = (chunk) => {
            const text = chunk.toString();
            out += text;
            // 从归档器输出提取人类可读的进度（解析规则见 lib/sync-report）
            for (const line of text.split('\n')) syncReport.updateProgress(progress, line);
        };
        // 归档器输出含中文，同样必须按流解码而不是逐块 toString
        child.stdout.setEncoding('utf-8');
        child.stderr.setEncoding('utf-8');
        child.stdout.on('data', onChunk);
        child.stderr.on('data', onChunk);
        child.on('close', (code) => {
            clearTimeout(timer);
            progress.running = false;
            const result = syncReport.buildSyncResult(code, out);
            if (result.ok) console.log(`[sync] done (archived=${result.archived})`);
            else console.error('[sync] archiver exited with code', code);
            res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
            res.end(JSON.stringify(result));
        });
        child.on('error', (err) => {
            clearTimeout(timer);
            progress.running = false;
            res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
            res.end(JSON.stringify({ ok: false, error: err.message }));
        });
        })();
        return;
    }

    // 同步进度（前端在 Sync 期间每 2s 轮询）
    if (url.pathname === '/api/sync-progress') {
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify(global.__syncProgress || { running: false }));
        return;
    }

    // Schedule: read/update launchd interval (macOS only)
    if (url.pathname === '/api/schedule') {
        if (process.platform !== 'darwin') {
            res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
            res.end(JSON.stringify({ supported: false }));
            return;
        }

        // 纳管所有指向本项目归档器的 launchd 任务，而不是硬编码一个 label。
        // 之前只认 'com.allo.weibo-chat-archive'，而历史 setup.sh 装的是
        // 'com.allo.weibo-archive'（日历触发每天 04:00）：界面显示"定时: 关闭"，
        // 任务却每天半夜照跑，归档读消息把微博客户端的未读提示清掉了（实测踩过）。
        const CANONICAL_LABEL = 'com.allo.weibo-chat-archive';
        const AGENT_DIR = path.join(process.env.HOME || '', 'Library/LaunchAgents');
        const CANONICAL_PATH = path.join(AGENT_DIR, `${CANONICAL_LABEL}.plist`);
        const agents = findArchiveAgents(AGENT_DIR, fs);

        /** 哪些任务当前真的被 launchd 加载了。 */
        const loadedLabels = (cb) => {
            exec('launchctl list', (err, stdout) => {
                if (err) return cb([]);
                cb(agents.filter(a => stdout.includes(a.label)).map(a => a.label));
            });
        };

        if (req.method === 'GET') {
            loadedLabels((loaded) => {
                const active = agents.filter(a => loaded.includes(a.label));
                // interval 供下拉回显；日历触发型没有 interval，用 describe 说明真实节奏
                const withInterval = active.find(a => a.interval > 0);
                res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
                res.end(JSON.stringify({
                    supported: true,
                    enabled: active.length > 0,
                    interval: withInterval ? withInterval.interval : 0,
                    jobs: active.map(a => ({ label: a.label, schedule: describeSchedule(a) })),
                    known: agents.map(a => a.label),
                }));
            });
            return;
        }

        if (req.method === 'POST') {
            let body = '';
            req.setEncoding('utf-8');
            req.on('data', chunk => { body += chunk; });
            req.on('end', () => {
                try {
                    const { interval } = JSON.parse(body);
                    if (typeof interval !== 'number' || interval < 0) {
                        res.writeHead(400, { 'Content-Type': 'application/json' });
                        res.end(JSON.stringify({ ok: false, error: 'Invalid interval' }));
                        return;
                    }

                    // 关闭必须卸载全部任务：只卸自己那一个，用户以为关了、别的还在跑
                    const unloadAll = agents.map(a => `launchctl unload "${a.file}" 2>/dev/null`).join('; ') || 'true';

                    if (interval === 0) {
                        exec(unloadAll, () => {
                            console.log(`[schedule] 已停用 ${agents.length} 个定时归档任务`);
                            res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
                            res.end(JSON.stringify({ ok: true, enabled: false, interval: 0 }));
                        });
                        return;
                    }

                    let content;
                    try { content = fs.readFileSync(CANONICAL_PATH, 'utf-8'); } catch {
                        res.writeHead(404, { 'Content-Type': 'application/json' });
                        res.end(JSON.stringify({ ok: false, error: 'Plist not found. Run setup.sh first.' }));
                        return;
                    }
                    content = content.replace(
                        /(<key>StartInterval<\/key>\s*<integer>)\d+(<\/integer>)/,
                        `$1${interval}$2`
                    );
                    fs.writeFileSync(CANONICAL_PATH, content, 'utf-8');

                    // 先全卸再只加载 canonical：避免两个任务同时归档（会互相抢会话）
                    exec(`${unloadAll}; launchctl load "${CANONICAL_PATH}"`, (err) => {
                        if (err) {
                            res.writeHead(500, { 'Content-Type': 'application/json' });
                            res.end(JSON.stringify({ ok: false, error: err.message }));
                            return;
                        }
                        console.log(`[schedule] 定时归档已设为每 ${interval} 秒（仅 ${CANONICAL_LABEL}）`);
                        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
                        res.end(JSON.stringify({ ok: true, enabled: true, interval }));
                    });
                } catch (e) {
                    res.writeHead(400, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ ok: false, error: e.message }));
                }
            });
            return;
        }
    }

    // Image proxy: /api/image?fid=xxx (with disk cache)
    if (url.pathname === '/api/image') {
        const fid = url.searchParams.get('fid');
        if (!fid) { res.writeHead(400); res.end('Missing fid'); return; }

        const cacheFile = path.join(CACHE_DIR, `${fid}.jpg`);
        if (fs.existsSync(cacheFile)) {
            serveImage(res, cacheFile, 'image/jpeg');
            return;
        }

        const imageUrl = `https://upload.api.weibo.com/2/mss/msget?source=209678993&fid=${fid}`;
        const cookieHeader = loadCookies();
        const proxyReq = https.get(imageUrl, {
            headers: {
                'Cookie': cookieHeader,
                'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36',
                'Referer': 'https://api.weibo.com/chat',
                'X-Requested-With': 'XMLHttpRequest',
            },
        }, (proxyRes) => {
            absorbSetCookies(proxyRes, imageUrl);
            if (proxyRes.statusCode !== 200) {
                res.writeHead(proxyRes.statusCode);
                res.end('Image fetch failed');
                return;
            }
            const ct = proxyRes.headers['content-type'] || 'image/jpeg';
            res.writeHead(200, {
                'Content-Type': ct,
                'Cache-Control': 'public, max-age=86400',
            });
            const chunks = [];
            proxyRes.on('data', chunk => chunks.push(chunk));
            proxyRes.on('end', () => {
                const buffer = Buffer.concat(chunks);
                // 超大条目不写缓存：代理把任何响应都按 ${fid}.jpg 落盘，视频也被
                // 当图片缓存过（实测单个 75MB），白占空间还挤掉真正的图片
                if (isCacheable(buffer.length)) fs.writeFile(cacheFile, buffer, () => {});
                res.end(buffer);
            });
        });
        proxyReq.on('error', () => { if (!res.headersSent) { res.writeHead(500); res.end('Proxy error'); } });
        proxyReq.setTimeout(15000, () => { proxyReq.destroy(); if (!res.headersSent) { res.writeHead(504); res.end('Timeout'); } });
        return;
    }

    // sinaimg CDN image proxy
    if (url.pathname === '/api/sinaimg') {
        const imgUrl = url.searchParams.get('url');
        if (!imgUrl || !/^https:\/\/[a-z0-9]+\.sinaimg\.cn\//.test(imgUrl)) { res.writeHead(403); res.end('Forbidden'); return; }
        const proxyReq = https.get(imgUrl, {
            headers: {
                'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36',
                'Referer': 'https://weibo.com/',
            },
        }, (proxyRes) => {
            if (proxyRes.statusCode !== 200) {
                res.writeHead(proxyRes.statusCode);
                res.end('Image fetch failed');
                return;
            }
            const ct = proxyRes.headers['content-type'] || 'image/jpeg';
            res.writeHead(200, {
                'Content-Type': ct,
                'Cache-Control': 'public, max-age=86400',
            });
            proxyRes.pipe(res);
        });
        proxyReq.on('error', () => { if (!res.headersSent) { res.writeHead(500); res.end('Proxy error'); } });
        proxyReq.setTimeout(15000, () => { proxyReq.destroy(); if (!res.headersSent) { res.writeHead(504); res.end('Timeout'); } });
        return;
    }

    // AI config: read/write ai-config.json
    if (url.pathname === '/api/ai-config') {
        const AI_CONFIG_PATH = path.join(__dirname, 'ai-config.json');

        if (req.method === 'GET') {
            try {
                const cfg = JSON.parse(fs.readFileSync(AI_CONFIG_PATH, 'utf-8'));
                const masked = { ...cfg };
                if (masked.apiKey) {
                    const k = masked.apiKey;
                    masked.apiKey = k.length > 8 ? k.slice(0, 3) + '***' + k.slice(-4) : '***';
                }
                res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
                res.end(JSON.stringify({ ok: true, config: masked }));
            } catch {
                res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
                res.end(JSON.stringify({ ok: true, config: null }));
            }
            return;
        }

        if (req.method === 'POST') {
            let body = '';
            req.setEncoding('utf-8');
            req.on('data', chunk => { body += chunk; });
            req.on('end', () => {
                try {
                    const { baseUrl, apiKey, model, vision } = JSON.parse(body);
                    let existingKey = '';
                    try { existingKey = JSON.parse(fs.readFileSync(AI_CONFIG_PATH, 'utf-8')).apiKey || ''; } catch {}
                    const cfg = { baseUrl: baseUrl || '', apiKey: apiKey || existingKey, model: model || '', vision: !!vision };
                    fs.writeFileSync(AI_CONFIG_PATH, JSON.stringify(cfg, null, 2), 'utf-8');
                    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
                    res.end(JSON.stringify({ ok: true }));
                } catch (e) {
                    res.writeHead(400, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ ok: false, error: e.message }));
                }
            });
            return;
        }
    }

    // AI summary: generate or return cached
    if (url.pathname === '/api/summary' && req.method === 'GET') {
        const group = url.searchParams.get('group') || '';
        const date = url.searchParams.get('date') || '';
        // summary_${date}.json 会被写盘，date 必须先校验（否则可穿越出 output/ 任意写）
        if (!messageStore.isValidDate(date)) {
            res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
            res.end(JSON.stringify({ ok: false, error: 'Invalid date' }));
            return;
        }

        const AI_CONFIG_PATH = path.join(__dirname, 'ai-config.json');
        let aiConfig;
        try { aiConfig = JSON.parse(fs.readFileSync(AI_CONFIG_PATH, 'utf-8')); } catch {
            res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
            res.end(JSON.stringify({ ok: false, error: '未配置 AI，请先在设置中配置' }));
            return;
        }
        if (!aiConfig.baseUrl || !aiConfig.apiKey || !aiConfig.model) {
            res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
            res.end(JSON.stringify({ ok: false, error: 'AI 配置不完整' }));
            return;
        }

        // Check cache
        const dir = getGroupDir(group);
        const cacheFile = path.join(dir, `summary_${date}.json`);
        if (fs.existsSync(cacheFile)) {
            try {
                const cached = JSON.parse(fs.readFileSync(cacheFile, 'utf-8'));
                res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
                res.end(JSON.stringify({ ok: true, summary: cached.summary, cached: true }));
                return;
            } catch {}
        }

        // Load messages for the date
        const messages = loadMessagesByDate(group, date);
        if (!messages.length) {
            res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
            res.end(JSON.stringify({ ok: false, error: '当天无消息数据' }));
            return;
        }

        // Format messages for LLM — track pic positions for vision enrichment
        let formatted = messages.map((m) => {
            const t = m.time ? m.time.split(' ')[1]?.slice(0, 5) : '';
            let text = m.content || '';
            if (m.share) text += ` [分享: ${m.share.title || m.share.text || m.share.url}]`;
            if (m.pics && m.pics.length) text += ` [图片x${m.pics.length}]`;
            return `[${t}] ${m.user}: ${text}`;
        }).join('\n');

        const systemPrompt = `你是一个群聊记录分析助手。请对以下微博群聊记录进行话题提炼和总结。

核心要求：
1. **准确性第一**：只总结消息中明确出现的内容，不要推测或补充未提及的信息
2. **话题识别**：将消息按讨论话题聚类，即使话题在时间上是交叉的也要分开归纳
3. **保留关键观点**：记录谁说了什么关键观点，用「用户名：观点」格式标注
4. **忽略噪声**：跳过纯表情回复、红包提示、系统消息、无实质内容的附和

重点标识（如果当天出现以下内容，请用标签醒目标出）：
- 💰 **财经/投资**：股票、基金、行情分析、投资决策相关讨论
- 🎁 **好物推荐**：工具、App、书籍、硬件等推荐，标注推荐人和理由
- 👤 **tombkeeper 发言**：此用户的观点和分享单独标注（无论在哪个话题中）

输出格式：
## 话题一：[话题标题] [标签]
[2-4句话概括讨论内容，标注关键发言人和核心观点]

## 话题二：[话题标题] [标签]
...

## 值得关注的链接/分享
- [标题或描述](链接) — 分享者：xxx
（没有则省略此节）

注意：
- 话题标题要具体，不要用"日常闲聊"这种模糊表述
- [标签] 为 💰/🎁/👤 之一或多个，不符合任何重点类别则不加标签
- 如果某条消息是在引用/回复另一条，注意还原对话上下文
- 不确定的内容宁可不写，不要编造`;

        // Helper: call OpenAI-compatible API
        function callApi(llmMessages, onSuccess, onError) {
            const reqBody = JSON.stringify({ model: aiConfig.model, messages: llmMessages });
            const apiUrl = new URL(aiConfig.baseUrl.replace(/\/$/, '') + '/chat/completions');
            const isHttps = apiUrl.protocol === 'https:';
            const httpModule = isHttps ? https : http;
            const options = {
                hostname: apiUrl.hostname,
                port: apiUrl.port || (isHttps ? 443 : 80),
                path: apiUrl.pathname + apiUrl.search,
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${aiConfig.apiKey}`,
                },
                agent: false,
            };
            const llmReq = httpModule.request(options, (llmRes) => {
                const chunks = [];
                llmRes.on('data', chunk => chunks.push(chunk));
                llmRes.on('end', () => {
                    const body = Buffer.concat(chunks).toString();
                    try {
                        const data = JSON.parse(body);
                        if (data.error) { onError(data.error.message || JSON.stringify(data.error)); return; }
                        onSuccess(data.choices?.[0]?.message?.content || '');
                    } catch (e) { onError('LLM 返回解析失败: ' + e.message); }
                });
            });
            llmReq.on('error', (e) => onError('LLM 请求失败: ' + e.message));
            llmReq.setTimeout(90000, () => { llmReq.destroy(); onError('LLM 请求超时（90s）'); });
            llmReq.end(reqBody);
        }

        // Final summary call
        function callSummary() {
            const llmMessages = [
                { role: 'system', content: systemPrompt },
                { role: 'user', content: `以下是 ${date} 的群聊记录（${messages.length} 条消息）：\n\n${formatted}` }
            ];
            callApi(llmMessages, (summary) => {
                try { fs.writeFileSync(cacheFile, JSON.stringify({ summary, date, generatedAt: new Date().toISOString() }), 'utf-8'); } catch {}
                res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
                res.end(JSON.stringify({ ok: true, summary, cached: false }));
            }, (err) => {
                if (!res.headersSent) {
                    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
                    res.end(JSON.stringify({ ok: false, error: err }));
                }
            });
        }

        // Vision two-step: describe images first, enrich text, then summarize
        if (aiConfig.vision) {
            // Collect images with their message context
            const imageItems = [];
            for (const m of messages) {
                if (m.pics && imageItems.length < 5) {
                    for (const pic of m.pics) {
                        if (imageItems.length >= 5) break;
                        const t = m.time ? m.time.split(' ')[1]?.slice(0, 5) : '';
                        imageItems.push({ url: pic, user: m.user, time: t, context: (m.content || '').slice(0, 50) });
                    }
                }
            }
            if (imageItems.length > 0) {
                const cookieHeader = loadCookies();
                const fetchImage = (picUrl) => new Promise((resolve) => {
                    let imgUrl = picUrl;
                    let fid = null;
                    if (picUrl.startsWith('/api/image?fid=')) {
                        fid = picUrl.split('fid=')[1];
                        imgUrl = `https://upload.api.weibo.com/2/mss/msget?source=209678993&fid=${fid}`;
                    } else {
                        const fidMatch = picUrl.match(/fid=(\d+)/);
                        if (fidMatch) fid = fidMatch[1];
                    }
                    const imgCacheFile = fid ? path.join(CACHE_DIR, `${fid}.jpg`) : path.join(CACHE_DIR, picUrl.replace(/[^a-zA-Z0-9]/g, '_').slice(-40) + '.jpg');
                    if (fs.existsSync(imgCacheFile)) {
                        const stat = fs.statSync(imgCacheFile);
                        if (stat.size > 3.5 * 1024 * 1024) { resolve(null); return; }
                        const imgBuf = fs.readFileSync(imgCacheFile);
                        const isPng = imgBuf[0] === 0x89 && imgBuf[1] === 0x50;
                        if (imgBuf[0] !== 0xFF && !isPng) { resolve(null); return; }
                        const mime = isPng ? 'image/png' : 'image/jpeg';
                        resolve(`data:${mime};base64,` + imgBuf.toString('base64'));
                        return;
                    }
                    https.get(imgUrl, { headers: { 'Cookie': cookieHeader, 'Referer': 'https://api.weibo.com/chat' } }, (imgRes) => {
                        absorbSetCookies(imgRes, imgUrl);
                        if (imgRes.statusCode !== 200) { resolve(null); return; }
                        const chunks = [];
                        imgRes.on('data', c => chunks.push(c));
                        imgRes.on('end', () => {
                            const buf = Buffer.concat(chunks);
                            if (buf.length > 3.5 * 1024 * 1024) { resolve(null); return; }
                            const isJpeg = buf[0] === 0xFF && buf[1] === 0xD8 && buf[2] === 0xFF;
                            const isPng = buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4E && buf[3] === 0x47;
                            if (!isJpeg && !isPng) { resolve(null); return; }
                            try { fs.writeFileSync(imgCacheFile, buf); } catch {}
                            const mime = isPng ? 'image/png' : 'image/jpeg';
                            resolve(`data:${mime};base64,` + buf.toString('base64'));
                        });
                    }).on('error', () => resolve(null));
                });

                // Step 1: Download all images
                Promise.all(imageItems.map(item => fetchImage(item.url))).then((base64Results) => {
                    // Pair images with their context
                    const validImages = [];
                    for (let i = 0; i < base64Results.length; i++) {
                        if (base64Results[i]) {
                            validImages.push({ base64: base64Results[i], ...imageItems[i] });
                        }
                    }
                    if (!validImages.length) { callSummary(); return; }

                    // Step 2: Describe each image via vision API
                    let described = 0;
                    const descriptions = new Array(validImages.length);
                    validImages.forEach((img, idx) => {
                        const descMessages = [
                            { role: 'user', content: [
                                { type: 'text', text: `这是群聊中 ${img.user} 在 ${img.time} 发的图片${img.context ? '，消息文字：' + img.context : ''}。请用一句话简要描述图片内容（20-50字），只描述你看到的，不要猜测。` },
                                { type: 'image_url', image_url: { url: img.base64 } }
                            ] }
                        ];
                        callApi(descMessages, (desc) => {
                            descriptions[idx] = desc.replace(/\n/g, ' ').slice(0, 100);
                            described++;
                            if (described === validImages.length) {
                                // Step 3: Enrich formatted text with descriptions
                                for (let i = 0; i < validImages.length; i++) {
                                    const img = validImages[i];
                                    const placeholder = `[${img.time}] ${img.user}:`;
                                    const line = formatted.split('\n').find(l => l.includes(placeholder) && l.includes('[图片'));
                                    if (line) {
                                        const enriched = line.replace(/\[图片x\d+\]/, `[图片: ${descriptions[i]}]`);
                                        formatted = formatted.replace(line, enriched);
                                    }
                                }
                                callSummary();
                            }
                        }, (_err) => {
                            descriptions[idx] = null;
                            described++;
                            if (described === validImages.length) {
                                for (let i = 0; i < validImages.length; i++) {
                                    if (!descriptions[i]) continue;
                                    const img = validImages[i];
                                    const placeholder = `[${img.time}] ${img.user}:`;
                                    const line = formatted.split('\n').find(l => l.includes(placeholder) && l.includes('[图片'));
                                    if (line) {
                                        const enriched = line.replace(/\[图片x\d+\]/, `[图片: ${descriptions[i]}]`);
                                        formatted = formatted.replace(line, enriched);
                                    }
                                }
                                callSummary();
                            }
                        });
                    });
                });
            } else {
                callSummary();
            }
        } else {
            callSummary();
        }
        return;
    }

    // --- Tauri signal endpoints (HTTP-based IPC for desktop app) ---
    if (url.pathname === '/api/request-login' && req.method === 'POST') {
        global.__pendingAction = 'open_login';
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true }));
        return;
    }
    if (url.pathname === '/api/pending-action') {
        const action = global.__pendingAction || null;
        global.__pendingAction = null;
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ action }));
        return;
    }
    // 浏览器版登录：用 Puppeteer 开可见 Chrome 扫码，成功后自动存 cookies.json。
    // 用运行时拼接路径 require，避免 Bun --compile（桌面 sidecar）静态打包
    // puppeteer 依赖链（cosmiconfig → 可选 typescript）导致编译失败；桌面应用
    // 走 Rust 原生登录窗口，本分支只在浏览器版（系统 node 运行）用到。
    if (url.pathname === '/api/browser-login' && req.method === 'POST') {
        const reply = (result) => {
            res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
            res.end(JSON.stringify(result));
        };
        try {
            const modPath = require('path').join(__dirname, 'lib', 'browser-login.js');
            const { browserLogin } = require(modPath);
            // 扫码成功后立即保活一次：拿到全新会话的同时把 24h 滚动 Cookie 也续上
            browserLogin().then(async (r) => {
                if (r.ok) await keepAliveTick('扫码登录');
                reply(r);
            }).catch(e => reply({ ok: false, error: e.message }));
        } catch (e) {
            reply({ ok: false, error: '浏览器登录不可用：' + e.message });
        }
        return;
    }

    // --- Q&A Endpoint (Agentic RAG) ---
    if (url.pathname === '/api/qa' && req.method === 'POST') {
        let body = '';
        req.setEncoding('utf-8');
        req.on('data', c => body += c);
        req.on('end', () => {
            const reply = (data) => { res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' }); res.end(JSON.stringify(data)); };
            let params;
            try { params = JSON.parse(body); } catch { reply({ ok: false, error: '参数解析失败' }); return; }
            const { group, question, mode } = params;
            if (!group || !question) { reply({ ok: false, error: '缺少 group 或 question' }); return; }

            const allMessages = loadMessages(group);
            if (!allMessages.length) { reply({ ok: false, error: '该群无消息数据' }); return; }

            if (mode === 'legacy') {
                // Legacy mode: original keyword extraction approach
                qaLegacy(question, allMessages, reply);
                return;
            }

            // Agent mode (default): Vercel AI SDK with tool-use loop
            let aiConfig;
            try { aiConfig = JSON.parse(fs.readFileSync(path.join(__dirname, 'ai-config.json'), 'utf-8')); } catch {
                reply({ ok: false, error: 'AI 未配置' }); return;
            }
            import('./qa-agent.mjs').then(({ askAgent }) => {
                // groupDir 供块级检索读取 qa-index/ 离线标注(缺失时自动降级)
                askAgent(question, allMessages, aiConfig, { groupDir: getGroupDir(group) }).then(reply).catch(e => {
                    reply({ ok: false, error: 'Agent 异常: ' + e.message });
                });
            }).catch(e => {
                reply({ ok: false, error: '加载 Agent 模块失败: ' + e.message });
            });
        });
        return;
    }


    // Static page
    if (url.pathname === '/' || url.pathname === '/index.html') {
        let html = fs.readFileSync(path.join(__dirname, 'viewer.html'), 'utf-8');
        // 按请求的 User-Agent 判断是否桌面应用的 WebView（它带自定义 UA
        // 标识 "WeiboChatDesktop"）。这样同一个端口既能服务桌面 app（登录走
        // Rust 原生扫码窗），也能服务普通浏览器（登录走 Puppeteer 扫码）。
        const ua = req.headers['user-agent'] || '';
        const isDesktop = ua.includes('WeiboChatDesktop');
        html = html.replace('<head>', `<head><script>window.__WEIBO_DESKTOP=${isDesktop};</script>`);
        res.writeHead(200, {
            'Content-Type': 'text/html; charset=utf-8',
            'Cache-Control': 'no-cache, no-store, must-revalidate',
        });
        res.end(html);
        return;
    }

    // 静态 JS 模块（lib/*.js）
    if (/^\/lib\/[\w-]+\.js$/.test(url.pathname)) {
        const filePath = path.join(__dirname, url.pathname);
        if (fs.existsSync(filePath)) {
            res.writeHead(200, {
                'Content-Type': 'application/javascript; charset=utf-8',
                'Cache-Control': 'no-cache, no-store, must-revalidate',
            });
            res.end(fs.readFileSync(filePath, 'utf-8'));
            return;
        }
    }

    res.writeHead(404);
    res.end('Not Found');
});

// 端口被占用时给出可操作的提示（最常见原因：桌面应用已在运行）
server.on('error', (err) => {
    if (err.code === 'EADDRINUSE') {
        console.error(`端口 ${PORT} 已被占用 —— 可能「微博群聊」桌面应用正在运行。`);
        console.error(`  · 直接用浏览器访问 http://localhost:${PORT} 即可（服务是同一个）`);
        console.error(`  · 或退出桌面应用后重新运行本命令`);
        console.error(`  · 或换端口：WEIBO_PORT=3457 npm run view`);
        process.exit(1);
    }
    throw err;
});

// 只监听回环地址：归档内容与 /api/request-login 等写操作都无鉴权，
// 绑 0.0.0.0 会让同网段任意主机读取全部聊天记录并远程触发登录弹窗。
server.listen(PORT, '127.0.0.1', () => {
    const url = `http://localhost:${PORT}`;
    console.log(`Weibo Group Chat Viewer: ${url}`);
    keepAliveTick('启动');
    // 图片缓存淘汰：启动时一次 + 每 6 小时一次。缓存内容都能从 CDN 再取，
    // 所以淘汰是安全的；不做则只增不减（实测涨到 688MB）。
    const evictTick = () => {
        const r = evictCache(CACHE_DIR);
        if (r.deleted > 0) {
            console.log(`[cache] 淘汰 ${r.deleted} 个条目，释放 ${(r.freedBytes / 1048576).toFixed(0)} MB，`
                + `剩余 ${(r.remainingBytes / 1048576).toFixed(0)} MB`);
        }
    };
    evictTick();
    setInterval(evictTick, 6 * 3600 * 1000).unref();
    // 自动打开浏览器（设 NO_OPEN=1 可禁用）
    if (!process.env.NO_OPEN) {
        const opener = process.platform === 'darwin' ? 'open'
            : process.platform === 'win32' ? 'start' : 'xdg-open';
        require('child_process').exec(`${opener} ${url}`, () => {});
    }
});
