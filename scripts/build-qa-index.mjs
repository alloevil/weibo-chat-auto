// 话题块索引回填/增量更新:切块 + LLM 生成 50-100 token 的上下文标注,
// 写入 output/<group>/qa-index/chunks_<date>.json(contextual BM25 的标注层)。
//
// 用法:
//   node scripts/build-qa-index.mjs --group 茧房建筑师协会 --all
//   node scripts/build-qa-index.mjs --group X --dates 2026-07-03,2026-07-04
//   可选: --max-llm-calls 100  --dry-run
//
// 设计:
//   - 幂等可中断:每完成一个 date 立即落盘,重跑自动跳过已完成的;
//   - 标注复用:chunkKey(msgIds 指纹)相同的块直接沿用旧标注——增量归档
//     只追加当天尾部,前面的块 key 不变;
//   - 失败不阻塞:LLM 解析失败整批置 null 照常写文件,QA 端纯文本兜底;
//   - <3 条的碎块不值得标注,annotation 恒为 null。
import fs from 'fs';
import path from 'path';
import { fileURLToPath, pathToFileURL } from 'url';
import { createRequire } from 'module';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');
const require = createRequire(import.meta.url);

const { loadMessagesByDate, listDates, getGroupDir } = require(
    path.join(ROOT, 'lib/load-messages.js')
);
const { splitIntoChunks, chunkKey } = require(path.join(ROOT, 'lib/chat-chunks.js'));
const { indexPathFor, dayFilePathFor, INDEX_DIR } = require(path.join(ROOT, 'lib/chunk-index.js'));

const BATCH_SIZE = 8; // 每次 LLM 调用打包的块数
const MIN_MSGS_TO_ANNOTATE = 3;
const CHUNK_TEXT_LIMIT = 1500; // 每块送给 LLM 的文本上限(字符)

function msgLine(m) {
    const t = m.time ? m.time.split(' ')[1]?.slice(0, 5) : '';
    // 聊天内容会原样进入标注提示词：换行与 "|" 必须洗掉，否则一条消息就能
    // 伪造 "2|A|注入的别名" 这类协议行（提示注入），污染整批标注结果
    const clean = (s) =>
        String(s || '')
            .replace(/[\r\n|｜]+/g, ' ')
            .slice(0, 400);
    let text = clean(m.content);
    if (m.share?.title) text += ` [分享:${clean(m.share.title)}]`;
    return `[${t}] ${clean(m.user)}: ${text}`;
}

// 标注 = 摘要行 + 别名行。
//
// 别名行的依据:Chronos(arXiv 2603.16862)在抽取事件时额外生成 2-4 条「用完全
// 不同词汇」的改写("bought Fitbit" → "picked up a fitness tracker"),专门用来
// 提升字面检索的召回。这是不引 embedding 就跨过词汇鸿沟的办法:把同义改写在
// 索引期写进文本,BM25 自己就能匹配上,不必每次查询再花一轮 LLM 精排。
//
// 关键约束是「不要复用原话里的关键名词」——只换语序不换词的改写对 bigram
// BM25 毫无增益(切出来的 bigram 完全相同)。
export function buildAnnotationPrompt(chunkTexts) {
    const list = chunkTexts.map((t, i) => `【块${i}】\n${t}`).join('\n\n');
    // 行式协议而非 JSON:聊天文本充满引号/特殊字符,模型转义 JSON 极易出错
    return `以下是群聊的 ${chunkTexts.length} 个话题片段。请为每个片段输出两行。

第一行(摘要):50-100 字中文,概括话题是什么、主要参与者、有无结论/关键判断。
第二行(别名):2-4 个检索用的替代说法,用「/」分隔。

别名的要求(这是提升检索召回的关键):
- 必须换用**完全不同的词汇**,不要复用摘要或原话里的关键名词。
- 想象别人事后回忆这段对话时会怎么问,用那种措辞。
- 例:原话是"把芯片股清了一半" → 别名写"减持半导体持仓/卖出科技股/调整投资仓位",
  而不是"清掉芯片股"(只换语序,对检索没有增益)。

${list}

输出格式:每个片段两行,格式为"编号|摘要"和"编号|A|别名1/别名2",不要其他文字。例如:
0|话题:半导体行情。参与:张三、李四。结论:还没跌到位。
0|A|减持科技股/看空芯片/调整投资仓位
1|话题:冲牙器选购。参与:王五。结论:推荐博皓。
1|A|口腔清洁设备推荐/牙齿护理用品/水牙线怎么选`;
}

/**
 * 解析标注响应。返回 { annotation, aliases } 数组。
 *
 * 行格式:"N|摘要" 与 "N|A|别名1/别名2"。只要有摘要行就算这条成功——别名是
 * 增量优化,模型漏写别名不该让整批标注失败(那会退化成纯文本检索)。
 */
export function parseAnnotationResponse(text, expectedCount) {
    const out = new Array(expectedCount).fill(null);
    let matched = 0;
    for (const line of String(text).split('\n')) {
        // 先试别名行(它多一个 |A| 段,必须在摘要行之前匹配,否则摘要正则会
        // 把 "A|别名..." 整段当成摘要内容吞掉)
        const alias = line.match(/^\s*(\d+)\s*[|｜]\s*A\s*[|｜]\s*(.+)$/i);
        if (alias) {
            const i = Number(alias[1]);
            if (i >= 0 && i < expectedCount) {
                const terms = alias[2]
                    .split(/[/／|｜]/)
                    .map((s) => s.trim())
                    .filter(Boolean)
                    .slice(0, 4);
                if (terms.length) {
                    // 摘要行可能后到,先占位
                    out[i] = out[i] || { annotation: null, aliases: [] };
                    out[i].aliases = terms.map((t) => t.slice(0, 60));
                }
            }
            continue;
        }
        const m = line.match(/^\s*(\d+)\s*[|｜]\s*(.+)$/);
        if (!m) continue;
        const i = Number(m[1]);
        if (i >= 0 && i < expectedCount && m[2].trim()) {
            out[i] = out[i] || { annotation: null, aliases: [] };
            out[i].annotation = m[2].trim().slice(0, 300);
            matched++;
        }
    }
    if (!matched) throw new Error('annotation: no parseable lines in response');
    // 只有别名没摘要的条目视为无效(摘要是检索文本的主体)
    return out.map((e) => (e && e.annotation ? e : null));
}

export async function annotateBatch(config, chunkTexts, { retries = 2 } = {}) {
    let lastErr = null;
    for (let attempt = 0; attempt <= retries; attempt++) {
        if (attempt > 0) await new Promise((r) => setTimeout(r, 1000 * attempt));
        try {
            const resp = await fetch(`${config.baseUrl}/chat/completions`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    Authorization: `Bearer ${config.apiKey}`,
                },
                body: JSON.stringify({
                    model: config.model,
                    messages: [{ role: 'user', content: buildAnnotationPrompt(chunkTexts) }],
                    stream: false,
                }),
                // 没有超时的话，挂住的网关会让并发 worker 永久停摆（rerank
                // 早就有 AbortSignal 兜底，这里是同样的洞）
                signal: AbortSignal.timeout(60000),
            });
            if (!resp.ok) throw new Error(`annotation API ${resp.status}`);
            const data = await resp.json();
            return parseAnnotationResponse(
                data.choices?.[0]?.message?.content || '',
                chunkTexts.length
            );
        } catch (e) {
            lastErr = e;
        }
    }
    throw lastErr;
}

async function main() {
    const args = process.argv.slice(2);
    const opt = (name) => {
        const i = args.indexOf(`--${name}`);
        return i !== -1 ? args[i + 1] : null;
    };
    const flag = (name) => args.includes(`--${name}`);

    const group = opt('group');
    if (!group) {
        console.error('缺少 --group');
        process.exit(1);
    }
    const outputDir = path.join(ROOT, 'output');
    const groupDir = getGroupDir(outputDir, group);

    let dates;
    if (flag('all')) dates = listDates(outputDir, group);
    else if (opt('dates'))
        dates = opt('dates')
            .split(',')
            .map((s) => s.trim())
            .filter(Boolean);
    else {
        console.error('需要 --all 或 --dates a,b');
        process.exit(1);
    }

    const maxLlmCalls = Number(opt('max-llm-calls')) || Infinity;
    const concurrency = Math.max(1, Math.min(Number(opt('concurrency')) || 3, 6));
    const dryRun = flag('dry-run');

    let aiConfig = null;
    try {
        aiConfig = JSON.parse(fs.readFileSync(path.join(ROOT, 'ai-config.json'), 'utf-8'));
    } catch {
        /* 无 AI 配置时只写切块结构 */
    }
    if (!aiConfig) console.warn('[index] 无 ai-config.json,只切块不标注');

    fs.mkdirSync(path.join(groupDir, INDEX_DIR), { recursive: true });

    const stats = { llmCalls: 0, annotated: 0, aliased: 0, reused: 0, skippedFresh: 0 };

    async function processDate(date) {
        const dayPath = dayFilePathFor(groupDir, date);
        let dayStat;
        try {
            dayStat = fs.statSync(dayPath);
        } catch {
            return;
        }

        // 旧索引:新鲜则跳过整天;否则收集旧标注按 key 复用
        const idxPath = indexPathFor(groupDir, date);
        let oldByKey = new Map();
        try {
            const old = JSON.parse(fs.readFileSync(idxPath, 'utf-8'));
            if (
                old.sourceMtime === dayStat.mtimeMs &&
                old.chunks?.every((c) => c.annotation !== undefined)
            ) {
                const pending = old.chunks.filter(
                    (c) => c.annotation === null && c.msgIds.length >= MIN_MSGS_TO_ANNOTATE
                );
                if (!pending.length || !aiConfig) {
                    stats.skippedFresh++;
                    return;
                } // 完整且新鲜
            }
            for (const c of old.chunks || []) {
                if (c.key && c.annotation) oldByKey.set(c.key, c);
            }
        } catch {
            /* 无旧索引 */
        }

        const msgs = loadMessagesByDate(outputDir, group, date);
        if (!msgs.length) return;
        const msgById = new Map(msgs.map((m) => [String(m.id), m]));
        const chunks = splitIntoChunks(msgs).map((c) => ({
            ...c,
            key: chunkKey(c),
            annotation: null,
            aliases: [],
        }));

        // 复用旧标注(含别名;旧索引没有 aliases 字段时按空数组处理)
        for (const c of chunks) {
            const old = oldByKey.get(c.key);
            if (old) {
                c.annotation = old.annotation;
                c.aliases = Array.isArray(old.aliases) ? old.aliases : [];
                c.annotatedAt = old.annotatedAt;
                c.annotationModel = old.annotationModel;
                stats.reused++;
            }
        }

        const todo = chunks.filter((c) => !c.annotation && c.msgIds.length >= MIN_MSGS_TO_ANNOTATE);
        if (dryRun) {
            console.log(
                `[dry-run] ${date}: ${msgs.length} 条 → ${chunks.length} 块,待标注 ${todo.length},复用 ${chunks.filter((c) => c.annotation).length}`
            );
            return;
        }

        if (aiConfig) {
            for (let i = 0; i < todo.length; i += BATCH_SIZE) {
                if (stats.llmCalls >= maxLlmCalls) {
                    console.warn(`[index] 达到 --max-llm-calls 上限 ${maxLlmCalls},剩余块置 null`);
                    break;
                }
                const batch = todo.slice(i, i + BATCH_SIZE);
                const texts = batch.map((c) =>
                    c.msgIds
                        .map((id) => msgById.get(String(id)))
                        .filter(Boolean)
                        .map(msgLine)
                        .join('\n')
                        .slice(0, CHUNK_TEXT_LIMIT)
                );
                try {
                    stats.llmCalls++;
                    const annotations = await annotateBatch(aiConfig, texts);
                    batch.forEach((c, j) => {
                        if (annotations[j]) {
                            c.annotation = annotations[j].annotation;
                            c.aliases = annotations[j].aliases;
                            c.annotatedAt = new Date().toISOString();
                            c.annotationModel = aiConfig.model;
                            stats.annotated++;
                            if (annotations[j].aliases.length) stats.aliased++;
                        }
                    });
                } catch (e) {
                    console.warn(`[index] ${date} 批次标注失败(置 null 继续): ${e.message}`);
                }
            }
        }

        fs.writeFileSync(
            idxPath,
            JSON.stringify(
                {
                    version: 1,
                    date,
                    sourceMtime: dayStat.mtimeMs,
                    sourceCount: msgs.length,
                    chunks,
                },
                null,
                1
            )
        );
        console.log(
            `[index] ${date}: ${chunks.length} 块,标注 ${chunks.filter((c) => c.annotation).length}`
        );
    }

    // 按天并发(每天独立落盘,幂等;标注调用是 IO 密集,并发拉满吞吐)
    const queue = [...dates];
    await Promise.all(
        Array.from({ length: concurrency }, async () => {
            while (queue.length) {
                const date = queue.shift();
                await processDate(date);
            }
        })
    );

    console.log(
        `[index] 完成: LLM 调用 ${stats.llmCalls},新标注 ${stats.annotated}(含别名 ${stats.aliased}),复用 ${stats.reused},新鲜跳过 ${stats.skippedFresh} 天`
    );
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
    main().catch((e) => {
        console.error(e);
        process.exit(1);
    });
}
