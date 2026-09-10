#!/usr/bin/env node
// Q&A 延迟基准:对同一组问题分别跑 agent / legacy 模式,报告延迟与成功率。
//
// 存在的理由:README 里那张 Agent vs Legacy 表原本靠一个未入库的脚本
// (eval/benchmark-qa.mjs,随 ee2a63d 一起 untrack 移除)跑出来,于是数字
// 过期后没人能复现。这个版本入库,且不硬编码任何私有数据——群名与问题
// 都从命令行/文件传入,跑不跑得出来只取决于你自己的归档。
//
// 用法:
//   node scripts/viewer-server.js &                       # 先起查看器
//   node scripts/benchmark-qa.js --group <群名>           # 用内置通用问题
//   node scripts/benchmark-qa.js --group <群名> --questions my.json
//   node scripts/benchmark-qa.js --group <群名> --modes agent --repeat 3
//
// --questions 指向一个 JSON 文件,可以是字符串数组,也可以是
// { questions: [{ question: "..." }, ...] }(与旧 eval/questions.json 兼容)。
//
// 只测延迟与是否成功,不判答案对错:答案质量需要人工核对 golden facts,
// 那属于私有数据,不进仓库。

'use strict';

const fs = require('fs');

// 与归档内容无关的通用问题,覆盖两类检索路径(事实型 / 总结型)
const DEFAULT_QUESTIONS = [
    '最近大家在聊什么话题',
    '昨天有讨论什么',
    '上周有人分享过链接吗',
    '群里谁发言最多',
    '最近有讨论过 AI 吗',
];

function parseArgs(argv) {
    const opt = (name, fallback = null) => {
        const i = argv.indexOf(`--${name}`);
        return i !== -1 && argv[i + 1] ? argv[i + 1] : fallback;
    };
    return {
        group: opt('group'),
        base: opt('base', 'http://127.0.0.1:3456'),
        questionsFile: opt('questions'),
        modes: opt('modes', 'agent,legacy')
            .split(',')
            .map((s) => s.trim())
            .filter(Boolean),
        repeat: Math.max(1, Number(opt('repeat', '1')) || 1),
        json: argv.includes('--json'),
    };
}

function loadQuestions(file) {
    if (!file) return DEFAULT_QUESTIONS;
    const raw = JSON.parse(fs.readFileSync(file, 'utf-8'));
    const list = Array.isArray(raw) ? raw : raw.questions || [];
    const out = list.map((q) => (typeof q === 'string' ? q : q.question)).filter(Boolean);
    if (!out.length) throw new Error(`${file} 里没有可用问题`);
    return out;
}

async function runQuery(base, group, question, mode) {
    const start = Date.now();
    try {
        const resp = await fetch(`${base}/api/qa`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ group, question, mode }),
            // 查看器的 QA 有全局墙钟上限,这里再兜一层:请求彻底挂死时
            // 基准自己也不能无限等
            signal: AbortSignal.timeout(180000),
        });
        const data = await resp.json();
        return { ...data, elapsed: Date.now() - start, mode };
    } catch (e) {
        // 查看器没起来 / 端口不对时给出可操作的错误,而不是抛栈
        return { ok: false, error: `请求失败: ${e.message}`, elapsed: Date.now() - start, mode };
    }
}

const median = (xs) => {
    const s = [...xs].sort((a, b) => a - b);
    const m = s.length >> 1;
    return s.length % 2 ? s[m] : Math.round((s[m - 1] + s[m]) / 2);
};

async function main() {
    const args = parseArgs(process.argv.slice(2));
    if (!args.group) {
        console.error('缺少 --group <群名>。可用群名见 GET /api/groups');
        process.exit(1);
    }
    const questions = loadQuestions(args.questionsFile);

    const rows = [];
    for (const question of questions) {
        const row = { question, byMode: {} };
        for (const mode of args.modes) {
            const runs = [];
            for (let i = 0; i < args.repeat; i++) {
                const r = await runQuery(args.base, args.group, question, mode);
                runs.push(r);
                if (!args.json) {
                    const status = r.ok ? `${r.elapsed}ms` : `失败(${r.error})`;
                    process.stderr.write(`  [${mode}] ${question.slice(0, 16)} → ${status}\n`);
                }
            }
            // 中位数只统计成功轮:失败轮的 elapsed 往往很短(立即报错),
            // 混进去会把延迟中位数系统性拉低。全部失败时退回全量,数字只作占位。
            const okRuns = runs.filter((r) => r.ok);
            const statRuns = okRuns.length ? okRuns : runs;
            const firstOk = okRuns[0] || runs[0];
            row.byMode[mode] = {
                ok: runs.every((r) => r.ok),
                // repeat > 1 时取中位数,单次网络抖动不主导结果
                elapsed: median(statRuns.map((r) => r.elapsed)),
                steps: firstOk.steps,
                toolCalls: (firstOk.toolCalls || []).map((t) => t.tool),
                error: runs.find((r) => !r.ok)?.error,
            };
        }
        rows.push(row);
    }

    const summary = {};
    for (const mode of args.modes) {
        const rs = rows.map((r) => r.byMode[mode]);
        summary[mode] = {
            medianLatencyMs: median(rs.map((r) => r.elapsed)),
            successRate: `${rs.filter((r) => r.ok).length}/${rs.length}`,
        };
    }

    if (args.json) {
        console.log(
            JSON.stringify(
                {
                    group: args.group,
                    repeat: args.repeat,
                    capturedAt: new Date().toISOString(),
                    rows,
                    summary,
                },
                null,
                2
            )
        );
        return;
    }

    console.log(`\n=== Q&A benchmark: ${args.group} (repeat=${args.repeat}) ===\n`);
    console.log(`| 问题 | ${args.modes.map((m) => `${m}(ms)`).join(' | ')} | 步骤 |`);
    console.log(`|---|${args.modes.map(() => '---').join('|')}|---|`);
    for (const r of rows) {
        const cells = args.modes.map((m) => (r.byMode[m].ok ? r.byMode[m].elapsed : '失败'));
        console.log(
            `| ${r.question.slice(0, 18)} | ${cells.join(' | ')} | ${r.byMode[args.modes[0]].steps ?? '-'} |`
        );
    }
    console.log('\n汇总(延迟取中位数):');
    for (const mode of args.modes) {
        console.log(
            `  ${mode}: ${summary[mode].medianLatencyMs}ms, 成功 ${summary[mode].successRate}`
        );
    }
    console.log('\n注:只测延迟与是否成功,不判答案对错——答案质量需人工核对。');
}

if (require.main === module) {
    main().catch((e) => {
        console.error(e.message);
        process.exit(1);
    });
}

module.exports = { DEFAULT_QUESTIONS, loadQuestions, parseArgs, median };
