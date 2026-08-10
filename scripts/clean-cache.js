// 手动清理图片缓存：npm run clean:cache [-- --max-mb 200 --max-age-days 30 --dry-run]
//
// 查看器自己会在启动时和每 6 小时淘汰一次（默认 300MB / 90 天），这个脚本用于
// 一次性瘦身或换更激进的阈值。缓存内容都能从微博 CDN 再取，删掉只影响首次加载。
'use strict';

const path = require('path');
const { listEntries, planEviction, evictCache, DEFAULT_MAX_BYTES, DEFAULT_MAX_AGE_MS } = require('../lib/cache-store');

const CACHE_DIR = path.join(__dirname, '..', 'cache', 'images');
const MB = 1024 * 1024;

const args = process.argv.slice(2);
const opt = (name, def) => {
    const i = args.indexOf(`--${name}`);
    if (i === -1 || !args[i + 1]) return def;
    const v = Number(args[i + 1]);
    return Number.isFinite(v) ? v : def;
};

const maxBytes = opt('max-mb', DEFAULT_MAX_BYTES / MB) * MB;
const maxAgeMs = opt('max-age-days', DEFAULT_MAX_AGE_MS / 86400000) * 86400000;
const dryRun = args.includes('--dry-run');

const entries = listEntries(CACHE_DIR);
const before = entries.reduce((s, e) => s + e.size, 0);
console.log(`缓存现状: ${entries.length} 个条目 / ${(before / MB).toFixed(0)} MB`);
console.log(`策略: 上限 ${(maxBytes / MB).toFixed(0)} MB，超过 ${(maxAgeMs / 86400000).toFixed(0)} 天一律淘汰`);

if (dryRun) {
    const plan = planEviction(entries, { maxBytes, maxAgeMs });
    console.log(`[dry-run] 将删除 ${plan.names.length} 个条目，释放 ${(plan.freedBytes / MB).toFixed(0)} MB，`
        + `剩余 ${(plan.remainingBytes / MB).toFixed(0)} MB`);
    process.exit(0);
}

const r = evictCache(CACHE_DIR, { maxBytes, maxAgeMs });
console.log(`已删除 ${r.deleted} 个条目，释放 ${(r.freedBytes / MB).toFixed(0)} MB，`
    + `剩余 ${(r.remainingBytes / MB).toFixed(0)} MB`);
