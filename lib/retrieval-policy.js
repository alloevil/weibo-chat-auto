'use strict';

const { search, tokenize } = require('./search-bm25');

function questionQuery(question) {
    return String(question || '')
        .replace(
            /(?:请问|有没有|群里|大家|谁知道|谁分享过|讨论过|提到过|能不能|能否|可以帮我|帮我|告诉我)/g,
            ' '
        )
        .replace(
            /\b(?:a|an|the|is|are|was|were|do|does|did|has|have|had|can|could|would|please|anyone|someone|know|about|what|which|who|when|where|why|how|of|in|on|at|for|to|and)\b/gi,
            ' '
        )
        .replace(/\s+/g, ' ')
        .trim();
}

function retrievalQueries(query, question, keywords = []) {
    const queries = [];
    const seen = new Set();
    for (const raw of [query, questionQuery(question), ...keywords.slice(0, 2)]) {
        const text = String(raw || '')
            .trim()
            .slice(0, 512);
        const signature = [...new Set(tokenize(text))].sort().join('\u0000');
        if (!signature || seen.has(signature)) continue;
        seen.add(signature);
        queries.push(text);
    }
    return queries;
}

function fusedSearch(documents, queries, limit) {
    const candidates = new Map();
    queries.forEach((query, queryIndex) => {
        search(documents, query, { limit }).forEach((hit, rank) => {
            const candidate = candidates.get(hit.idx) || { idx: hit.idx, score: 0, ranks: [] };
            candidate.score += 1 / (60 + rank + 1);
            candidate.ranks.push({ queryIndex, rank: rank + 1, score: hit.score });
            candidates.set(hit.idx, candidate);
        });
    });
    return [...candidates.values()]
        .sort((left, right) => right.score - left.score || left.idx - right.idx)
        .slice(0, limit);
}

function recentQuery(question, args = {}) {
    if (args.dateFrom || args.dateTo) return false;
    const text = String(question || '');
    if (
        /去年|前年|当时|最早|最初|以前|过去|历史|上个?月|上上?周|\b(?:earliest|original|historical|previous|last year)\b|\b\d{4}[-/年]/i.test(
            text
        )
    )
        return false;
    return /最近|近期|最新|这几天|这两天|\b(?:latest|recent|newest)\b/i.test(text);
}

function rankByTime(hits, timestampOf, enabled) {
    const latest = hits.reduce(
        (maximum, hit) => Math.max(maximum, Number(timestampOf(hit.idx)) || 0),
        0
    );
    return hits
        .map((hit) => {
            const timestamp = Number(timestampOf(hit.idx)) || 0;
            const weight =
                enabled && latest && timestamp ? 0.5 ** ((latest - timestamp) / (2 * 86400000)) : 1;
            return { ...hit, fusedScore: hit.score, timeWeight: weight, score: hit.score * weight };
        })
        .sort((left, right) => right.score - left.score || left.idx - right.idx);
}

function hitExcerpt(text, query, limit = 120) {
    const value = String(text || '')
        .replace(/\s+/g, ' ')
        .trim();
    if (value.length <= limit) return value;
    const lower = value.toLowerCase();
    const tokens = [...new Set(tokenize(query))].sort((left, right) => right.length - left.length);
    const hit = tokens.map((token) => lower.indexOf(token)).find((index) => index >= 0) ?? 0;
    const start = Math.max(0, hit - Math.floor(limit / 4));
    return `${start ? '…' : ''}${value.slice(start, start + limit - 2)}…`.slice(0, limit);
}

function evidenceIndexes(length, anchors, limit = 17) {
    const selected = new Set();
    const centers = [...new Set(anchors)].filter(
        (index) => Number.isInteger(index) && index >= 0 && index < length
    );
    for (let radius = 0; radius < length && selected.size < Math.min(limit, length); radius++) {
        for (const center of centers) {
            for (const index of radius ? [center - radius, center + radius] : [center]) {
                if (index >= 0 && index < length && selected.size < limit) selected.add(index);
            }
        }
        if (!centers.length) break;
    }
    return [...selected].sort((left, right) => left - right);
}

function rerankExcerpt(messages, anchors, query, format, limit = 120) {
    const centers = anchors.slice(0, 2);
    const fragments = centers.map((index) =>
        hitExcerpt(format(messages[index]), query, centers.length > 1 ? 48 : 86)
    );
    const neighbor = centers.length
        ? [centers[0] - 1, centers[0] + 1].find(
              (index) => index >= 0 && index < messages.length && !centers.includes(index)
          )
        : undefined;
    if (neighbor !== undefined) fragments.push(hitExcerpt(format(messages[neighbor]), query, 28));
    return fragments.join(' | ').slice(0, limit);
}

module.exports = {
    questionQuery,
    retrievalQueries,
    fusedSearch,
    recentQuery,
    rankByTime,
    hitExcerpt,
    evidenceIndexes,
    rerankExcerpt,
};
