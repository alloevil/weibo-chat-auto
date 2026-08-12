// 修复历史损坏消息：把含替换字符（���）的消息重新从微博拉一遍。
//
//   node scripts/repair-encoding.mjs                 # 只扫描并报告
//   node scripts/repair-encoding.mjs --apply         # 真的重抓并覆盖
//   node scripts/repair-encoding.mjs --apply --group 猫咪AI研究
//
// 成因见 lib/read-stream.js：归档器旧代码逐块把 Buffer 转字符串，中文字跨
// chunk 边界即碎。代码已修（新采集不会再碎），但已落盘的坏数据只能重抓。
//
// 做法：坏消息的 id 是已知的，用 max_mid=<id+1> 直接取它所在的那一页，
// 一页 20 条能顺带覆盖邻近的其它坏消息；day-file 按 id 合并，新数据覆盖旧数据。
//
// ⚠️ 会读取群消息。若你在意微博客户端的未读提示，请在已经看过消息之后再跑。
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
// lib/ 是 CJS：静态 import 解构（与 qa-agent.mjs 同一套路，bundler 可静态分析）
import cookieStore from '../lib/cookie-store.js';
import normalizeMessageMod from '../lib/normalize-message.js';
import dayFile from '../lib/day-file.js';
import ms from '../lib/load-messages.js';

const { normalizeMessage } = normalizeMessageMod;
const { mergeIntoDayFile } = dayFile;

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const APPLY = args.includes('--apply');
const onlyGroup = args.includes('--group') ? args[args.indexOf('--group') + 1] : null;
const OUTPUT_DIR = path.join(ROOT, 'output');
const BAD = '\uFFFD';

/** 群名 → 归档器记录的会话 id。 */
function groupId(name) {
    const safe = name.replace(/[^a-zA-Z0-9一-鿿]/g, '_');
    try {
        return String(JSON.parse(fs.readFileSync(path.join(ROOT, 'state', `last-archive-state_${safe}.json`), 'utf-8')).groupId || '');
    } catch {
        return '';
    }
}

async function fetchPageBefore(gid, mid, cookieHeader) {
    const url = 'https://api.weibo.com/webim/groupchat/query_messages.json'
        + `?convert_emoji=1&query_sender=1&count=20&id=${gid}&max_mid=${mid}&source=209678993&t=${Date.now()}`;
    const resp = await fetch(url, {
        headers: { Cookie: cookieHeader, Referer: 'https://api.weibo.com/chat', 'X-Requested-With': 'XMLHttpRequest' },
        signal: AbortSignal.timeout(15000),
    });
    const data = await resp.json();
    if (data.error_code) throw new Error(`接口错误 ${data.error_code}: ${data.error || ''}`);
    return (Array.isArray(data.messages) ? data.messages : []).map(normalizeMessage).filter(Boolean);
}

const groups = fs.existsSync(OUTPUT_DIR)
    ? fs.readdirSync(OUTPUT_DIR, { withFileTypes: true }).filter(e => e.isDirectory()).map(e => e.name)
    : [];

let totalBad = 0;
const plan = [];
for (const g of groups) {
    if (onlyGroup && g !== onlyGroup) continue;
    const bad = ms.loadMessages(OUTPUT_DIR, g).filter(m => JSON.stringify(m).includes(BAD));
    if (bad.length === 0) continue;
    totalBad += bad.length;
    plan.push({ group: g, gid: groupId(g), bad });
    console.log(`${g}: ${bad.length} 条损坏（${[...new Set(bad.map(m => m.date))].length} 天）`);
}

if (totalBad === 0) {
    console.log('未发现损坏消息。');
    process.exit(0);
}
console.log(`\n合计 ${totalBad} 条。`);

if (!APPLY) {
    console.log('这是扫描模式。加 --apply 才会重抓并覆盖（会读取群消息）。');
    for (const p of plan.slice(0, 1)) {
        console.log(`\n样例（${p.group}）：`);
        p.bad.slice(0, 3).forEach(m => console.log(`  ${m.time} ${m.user}: ${String(m.content).slice(0, 50)}`));
    }
    process.exit(0);
}

const cookieHeader = cookieStore.cookieHeader();
let fixed = 0;
let failed = 0;

for (const { group, gid, bad } of plan) {
    if (!gid) {
        console.warn(`⚠ ${group} 没有会话 id（先跑一次归档），跳过`);
        continue;
    }
    // 按 id 降序处理，一页 20 条能覆盖邻近的坏消息，跳过已被覆盖的
    const pending = new Set(bad.map(m => String(m.id)));
    const ordered = [...bad].sort((a, b) => Number(b.id) - Number(a.id));
    for (const target of ordered) {
        if (!pending.has(String(target.id))) continue;
        try {
            // max_mid 取 id+1：接口返回比它更老的一页，正好包含目标消息
            const page = await fetchPageBefore(gid, String(BigInt(target.id) + 1n), cookieHeader);
            const good = page.filter(m => !JSON.stringify(m).includes(BAD));
            const byDate = new Map();
            for (const m of good) {
                if (!byDate.has(m.date)) byDate.set(m.date, []);
                byDate.get(m.date).push(m);
            }
            for (const [date, msgs] of byDate) {
                mergeIntoDayFile(path.join(OUTPUT_DIR, group, `weibo_chat_${date}.json`), msgs);
            }
            for (const m of page) {
                if (pending.delete(String(m.id))) fixed++;
            }
            await new Promise(r => setTimeout(r, 400));   // 别打太快
        } catch (e) {
            failed++;
            pending.delete(String(target.id));
            console.warn(`  ⚠ ${group} ${target.id} 重抓失败: ${e.message}`);
        }
    }
    ms.clearCaches();
}

console.log(`\n完成：修复 ${fixed} 条，失败 ${failed} 条。`);
console.log('重新扫描确认：node scripts/repair-encoding.mjs');
