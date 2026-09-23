// 切群流程集成测试:内联脚本跑在 Node sandbox 里,fetch 代理到真实 viewer-server,
// 模拟页面初始化 → switchGroup(),断言消息区/成员区确实切换。
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
const PORT = process.env.WEIBO_PORT || 3996;
const BASE = `http://localhost:${PORT}`;

function makeEl(id) {
    const classes = new Set();
    return {
        innerHTML: '',
        textContent: '',
        value: '',
        className: '',
        id,
        style: {},
        dataset: {},
        classList: {
            add(...names) {
                names.forEach((name) => classes.add(name));
            },
            remove(...names) {
                names.forEach((name) => classes.delete(name));
            },
            toggle(name, force) {
                const add = force === undefined ? !classes.has(name) : force;
                if (add) classes.add(name);
                else classes.delete(name);
                return add;
            },
            contains() {
                return classes.has(arguments[0]);
            },
        },
        setAttribute() {},
        toggleAttribute() {},
        appendChild() {},
        querySelector() {
            return null;
        },
        querySelectorAll() {
            return [];
        },
        addEventListener() {},
        scrollIntoView() {},
        focus() {},
        scrollTop: 0,
        scrollHeight: 0,
        offsetHeight: 0,
        getBoundingClientRect() {
            return { top: 0, left: 0, width: 0, height: 0 };
        },
    };
}

async function main() {
    const els = {};
    const sandbox = {
        console,
        setTimeout,
        clearTimeout,
        clearInterval,
        // 内联脚本会注册轮询（auth 状态等）；unref 让 harness 打完结论能正常退出
        setInterval(fn, ms) {
            const t = setInterval(fn, ms);
            t.unref?.();
            return t;
        },
        requestAnimationFrame(cb) {
            cb();
        },
        fetch: (url, opts) => fetch(BASE + url, opts),
        localStorage: {
            getItem() {
                return null;
            },
            setItem() {},
            removeItem() {},
        },
        // 页面启动即订阅实时同步；harness 只验证切群逻辑，给个惰性 stub
        EventSource: class {
            constructor() {
                this.readyState = 0;
            }
            close() {}
        },
        navigator: { userAgent: 'node-test' },
        location: { href: BASE + '/', search: '', reload() {} },
        addEventListener() {},
        removeEventListener() {},
        document: {
            getElementById(id) {
                return els[id] || (els[id] = makeEl(id));
            },
            querySelector(selector) {
                if (selector === '.main') return els.main || (els.main = makeEl('main'));
                if (selector === '.content')
                    return els.content || (els.content = makeEl('content'));
                return null;
            },
            querySelectorAll() {
                return [];
            },
            addEventListener() {},
            createElement() {
                return makeEl('');
            },
            documentElement: { dataset: {} },
            body: makeEl('body'),
            title: '',
        },
        window: null,
    };
    sandbox.window = sandbox;
    sandbox.globalThis = sandbox;
    vm.createContext(sandbox);

    const html = fs.readFileSync(path.join(ROOT, 'viewer.html'), 'utf-8');
    const requiredIcons = [
        'icon-chat',
        'icon-search',
        'icon-sync',
        'icon-settings',
        'icon-chart',
        'icon-download',
        'icon-users',
        'icon-filter',
        'icon-sparkles',
        'icon-at',
        'icon-list',
        'icon-key',
        'icon-smile',
        'icon-image',
        'icon-target',
        'icon-clock',
    ];
    if (requiredIcons.some((id) => !html.includes(`id="${id}"`))) {
        throw new Error('统一 SVG 图标集不完整');
    }
    if (!/id="syncBtn"[^>]*>[\s\S]*?#icon-sync[\s\S]*?button-label/.test(html)) {
        throw new Error('同步按钮未使用可保留动态图标的标签结构');
    }
    // viewer.html 有多个内联 <script>（head 的皮肤预加载 + 主逻辑），取最长的主逻辑块
    const script = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)]
        .map((b) => b[1])
        .sort((a, b) => b.length - a.length)[0];
    // viewer.html 还通过 <script src> 加载 text-utils(挂到 window)
    vm.runInContext(fs.readFileSync(path.join(ROOT, 'lib/text-utils.js'), 'utf-8'), sandbox, {
        filename: 'text-utils.js',
    });
    vm.runInContext(fs.readFileSync(path.join(ROOT, 'lib/viewer-filters.js'), 'utf-8'), sandbox, {
        filename: 'viewer-filters.js',
    });
    vm.runInContext(script, sandbox, { filename: 'viewer-inline.js' });

    const wait = (ms) => new Promise((r) => setTimeout(r, ms));

    // 页面初始化
    await vm.runInContext('loadData()', sandbox);
    await wait(300);
    const g1 = vm.runInContext('currentGroup', sandbox);
    const date1 = vm.runInContext('selectedDate', sandbox);
    const msgs1 = els['messages'].innerHTML;
    const users1 = els['userList'].innerHTML;
    console.log(`初始: group=${g1} date=${date1} msgs=${msgs1.length}字 users=${users1.length}字`);

    if (els.summaryBar.style.display !== '' || els.summaryBtn.textContent !== '配置 AI 摘要') {
        throw new Error('AI 未配置时摘要入口没有提供配置提示');
    }
    await vm.runInContext('toggleQaComposer()', sandbox);
    await wait(50);
    if (
        !els.settingsModal.classList.contains('show') ||
        !els.aiConfigAlert.textContent.includes('API Key')
    ) {
        throw new Error('AI 未配置时问答入口没有打开设置并说明缺失字段');
    }
    if (els.qaQuickPanel.classList.contains('show')) {
        throw new Error('AI 未配置时不应打开不可用的问答输入框');
    }
    vm.runInContext('closeSettings();dismissToast()', sandbox);
    console.log('AI 未配置引导正常');

    // 切群
    const groupIds = vm.runInContext('availableGroups.map(g => g.id)', sandbox);
    const target = groupIds.find((id) => id !== g1);
    if (!target) throw new Error('切群测试至少需要两个群');
    vm.runInContext(`switchGroup(${JSON.stringify(target)})`, sandbox);
    await wait(800);
    const g2 = vm.runInContext('currentGroup', sandbox);
    const date2 = vm.runInContext('selectedDate', sandbox);
    const msgs2 = els['messages'].innerHTML;
    const users2 = els['userList'].innerHTML;
    console.log(`切到: group=${g2} date=${date2} msgs=${msgs2.length}字 users=${users2.length}字`);

    const usersChanged = users2 !== users1;
    const msgsChanged = msgs2 !== msgs1;
    console.log(`成员区变化: ${usersChanged}  消息区变化: ${msgsChanged}`);
    if (usersChanged && !msgsChanged) {
        console.log('*** 复现 bug:成员切换但消息未切换 ***');
        process.exit(2);
    }
    if (!msgsChanged) {
        console.log('*** 消息区未变化 ***');
        process.exit(1);
    }

    const memberSummary = els.userSummary.textContent;
    if (!/^\d+ 人 · \d+ 条$/.test(memberSummary)) {
        console.log(`*** 成员摘要异常:${memberSummary} ***`);
        process.exit(1);
    }
    const firstUser = vm.runInContext(
        'allMessages.find(m => m.date === selectedDate)?.user',
        sandbox
    );
    vm.runInContext(`toggleUser(${JSON.stringify(firstUser)})`, sandbox);
    if (!els.userClear.classList.contains('show')) {
        console.log('*** 成员筛选生效后未显示清除入口 ***');
        process.exit(1);
    }
    vm.runInContext(`toggleUser(${JSON.stringify(firstUser)})`, sandbox);
    if (els.userClear.classList.contains('show')) {
        console.log('*** 成员筛选清空后仍占用清除入口 ***');
        process.exit(1);
    }
    console.log(`成员栏摘要正常:${memberSummary},清除入口按需显示`);

    const firstMessageId = vm.runInContext(
        'allMessages.find(m => m.date === selectedDate)?.id',
        sandbox
    );
    vm.runInContext(`openContext(${JSON.stringify(String(firstMessageId))})`, sandbox);
    if (!els.contextMeta.textContent.includes('/')) {
        console.log(`*** 上下文位置摘要异常:${els.contextMeta.textContent} ***`);
        process.exit(1);
    }
    if (!els.contextBody.innerHTML.includes('class="ctx-jump"')) {
        console.log('*** 上下文缺少紧凑跳转入口 ***');
        process.exit(1);
    }
    vm.runInContext('toggleContextDensity()', sandbox);
    if (
        !els.contextPanel.classList.contains('expanded') ||
        els.ctxDensityBtn.textContent !== '紧凑'
    ) {
        console.log('*** 上下文全文模式未生效 ***');
        process.exit(1);
    }
    vm.runInContext('toggleContextDensity()', sandbox);
    if (
        els.contextPanel.classList.contains('expanded') ||
        els.ctxDensityBtn.textContent !== '全文'
    ) {
        console.log('*** 上下文紧凑模式未恢复 ***');
        process.exit(1);
    }
    console.log(`上下文紧凑模式正常:${els.contextMeta.textContent}`);

    // 统计视图必须跟随切换后的群与日期生成摘要,且固定输出 4 个 KPI。
    vm.runInContext('toggleStats()', sandbox);
    const statsHtml = els.statsPanel.innerHTML;
    const kpiCount = (statsHtml.match(/class="stats-kpi"/g) || []).length;
    if (!statsHtml.includes('class="stats-overview"') || kpiCount !== 4) {
        console.log(
            `*** 统计摘要异常:overview=${statsHtml.includes('class="stats-overview"')} kpi=${kpiCount} ***`
        );
        process.exit(1);
    }
    console.log(`统计摘要正常:${kpiCount} 个 KPI`);
    console.log('切群流程正常');
}

main().catch((e) => {
    console.error('harness 异常:', e);
    process.exit(1);
});
