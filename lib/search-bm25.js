// 轻量中文检索：bigram 分词 + BM25 打分。纯 JS 零依赖。
//
// 背景：Q&A agent 原先用 text.includes(keyword) 子串匹配 + 命中计数打分，
// 中文无分词导致"投资"匹配不到"投了"、长消息稀释命中权重、无词频概念。
// BM25 + bigram 是中文场景无需词典的经典组合：查询与文档都切成二字滑窗，
// 部分重叠（"投资" vs "投资人"共享 bigram "投资"）自然获得部分分数。
'use strict';

// ── 分词 ──────────────────────────────────────────────────────────────
// CJK 连续段切 bigram（单字段落保留单字）；拉丁/数字段整体小写作为一个词。
function tokenize(text) {
    const tokens = [];
    if (!text) return tokens;
    // 匹配 CJK 段或 拉丁数字段
    const re = /([一-鿿㐀-䶿]+)|([A-Za-z0-9_@#.]+)/g;
    let m;
    while ((m = re.exec(text)) !== null) {
        if (m[1]) {
            const seg = m[1];
            if (seg.length === 1) {
                tokens.push(seg);
            } else {
                for (let i = 0; i < seg.length - 1; i++) tokens.push(seg.slice(i, i + 2));
            }
        } else {
            tokens.push(m[2].toLowerCase());
        }
    }
    return tokens;
}

// ── BM25 索引 ─────────────────────────────────────────────────────────
// 对一组文档（字符串）建立倒排。文档量为群聊消息级别（数千），毫秒级构建，
// 每次查询临时建索引即可，无需持久化。
function buildIndex(docs) {
    const df = new Map();            // token → 出现过的文档数
    const docTokens = new Array(docs.length);
    let totalLen = 0;
    for (let i = 0; i < docs.length; i++) {
        const toks = tokenize(docs[i]);
        docTokens[i] = toks;
        totalLen += toks.length;
        for (const t of new Set(toks)) df.set(t, (df.get(t) || 0) + 1);
    }
    return { df, docTokens, avgLen: docs.length ? totalLen / docs.length : 0, N: docs.length };
}

/**
 * BM25 检索。
 * @param {string[]} docs   文档数组（与返回的 idx 对应）
 * @param {string} query    查询串（可含多个关键词，空格或直接连写均可）
 * @param {object} [opts]   { k1=1.5, b=0.75, limit=50 }
 * @returns {Array<{idx:number, score:number}>} 按分数降序
 */
function search(docs, query, opts = {}) {
    const { k1 = 1.5, b = 0.75, limit = 50 } = opts;
    const qTokens = [...new Set(tokenize(query))];
    if (!qTokens.length || !docs.length) return [];

    const { df, docTokens, avgLen, N } = buildIndex(docs);

    const scores = new Map(); // idx → score
    for (const qt of qTokens) {
        const n = df.get(qt);
        if (!n) continue;
        const idf = Math.log(1 + (N - n + 0.5) / (n + 0.5));
        for (let i = 0; i < N; i++) {
            const toks = docTokens[i];
            if (!toks.length) continue;
            let tf = 0;
            for (const t of toks) if (t === qt) tf++;
            if (!tf) continue;
            const norm = (tf * (k1 + 1)) / (tf + k1 * (1 - b + b * (toks.length / avgLen)));
            scores.set(i, (scores.get(i) || 0) + idf * norm);
        }
    }

    return [...scores.entries()]
        .map(([idx, score]) => ({ idx, score }))
        .sort((a, b2) => b2.score - a.score)
        .slice(0, limit);
}

module.exports = { tokenize, search };
