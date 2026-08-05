const { test } = require('node:test');
const assert = require('node:assert');
const { buildSyncResult, updateProgress } = require('../lib/sync-report.js');

// 用与真实日志（logs/archive-error.log 事故现场）同构的输出串测试，
// 防止解析规则与归档器实际打印格式脱节 —— v1.11.0 前就是这么断的。

test('buildSyncResult: Cookie 失效 → needLogin，优先于原因提取', () => {
    const out = [
        '========================================',
        '  微博 Cookie 已失效，需要重新扫码登录',
        '  当前是 headless 模式，没有窗口可以扫码，本次归档中止。',
        '  请运行:  npm run save-cookies',
        '========================================',
        '错误: Error: Cookie 已失效，需要重新扫码登录（npm run save-cookies）',
        '    at main (/x/auto-archive-simple.js:385:23)',
    ].join('\n');
    const r = buildSyncResult(1, out);
    assert.strictEqual(r.ok, false);
    assert.strictEqual(r.needLogin, true);
    assert.match(r.error, /重新扫码/);
});

test('buildSyncResult: 非零退出取最后一条"错误:"行作为真实原因', () => {
    const out = [
        '尝试 1 失败: Navigation timeout of 60000 ms exceeded',
        '错误: TimeoutError: Navigation timeout of 60000 ms exceeded',
        '    at new Deferred (...)',
        '错误: Error: 2/3 个群未归档: 猫咪AI研究(未取到群 ID)、赛博动物园w(会话未切换)',
        '    at main (/x/auto-archive-simple.js:917:15)',
    ].join('\n');
    const r = buildSyncResult(1, out);
    assert.deepStrictEqual(r, { ok: false, error: '2/3 个群未归档: 猫咪AI研究(未取到群 ID)、赛博动物园w(会话未切换)' });
});

test('buildSyncResult: 无可解析原因时回退到退出码', () => {
    assert.deepStrictEqual(buildSyncResult(137, '被 SIGKILL 掐掉，没有错误行'), {
        ok: false,
        error: '归档器异常退出（code 137）',
    });
});

test('buildSyncResult: exit 0 按群头计数（不再依赖已删除的旧标志串）', () => {
    const out = [
        '目标群聊: 群A, 群B',
        '--- 归档群聊: 群A ---',
        '已按天拆分保存 2 个文件',
        '--- 归档群聊: 群B ---',
        '完成！',
    ].join('\n');
    assert.deepStrictEqual(buildSyncResult(0, out), { ok: true, archived: 2, skipped: 0 });
    assert.deepStrictEqual(buildSyncResult(0, ''), { ok: true, archived: 0, skipped: 0 });
});

test('updateProgress: 按真实输出顺序驱动进度状态机', () => {
    const p = { running: true, stage: '启动归档器…', current: 0, total: 0 };

    updateProgress(p, '目标群聊: 群A, 群B, 群C');
    assert.strictEqual(p.total, 3);

    updateProgress(p, '打开微博聊天页面...');
    assert.strictEqual(p.stage, '打开微博聊天页…');

    updateProgress(p, '--- 归档群聊: 群A ---');
    assert.deepStrictEqual([p.current, p.stage], [1, '正在归档「群A」（1/3）']);

    updateProgress(p, 'API 分页获取完成: 42 条消息');
    assert.strictEqual(p.stage, '正在归档「群A」完成（1/3）');

    updateProgress(p, '--- 归档群聊: 群B ---');
    assert.strictEqual(p.stage, '正在归档「群B」（2/3）');

    updateProgress(p, '普通日志行不影响进度');
    assert.strictEqual(p.stage, '正在归档「群B」（2/3）');
});

test('updateProgress: 未拿到 total 时显示 ?', () => {
    const p = { stage: '', current: 0, total: 0 };
    updateProgress(p, '--- 归档群聊: 群A ---');
    assert.strictEqual(p.stage, '正在归档「群A」（1/?）');
});
