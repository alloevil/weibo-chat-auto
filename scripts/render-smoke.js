// 渲染管线冒烟:提取 viewer.html 内联脚本,用最小 DOM stub 在 Node 中执行
// renderAll(),对每个群 × 最新/指定日期验证是否抛异常(复现"切群后消息区不更新")。
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
const ms = require(path.join(ROOT, 'lib/load-messages.js'));

function makeEl() {
    return {
        innerHTML: '', textContent: '', value: '', className: '', id: '',
        style: {}, dataset: {},
        classList: { add() {}, remove() {}, toggle() {}, contains() { return false; } },
        appendChild() {}, querySelector() { return null; }, querySelectorAll() { return []; },
        addEventListener() {}, scrollIntoView() {}, focus() {},
        scrollTop: 0, scrollHeight: 0, offsetHeight: 0,
        getBoundingClientRect() { return { top: 0, left: 0, width: 0, height: 0 }; },
    };
}

function buildSandbox() {
    const els = {};
    const sandbox = {
        console, setTimeout, clearTimeout, setInterval, clearInterval,
        requestAnimationFrame(cb) { cb(); },
        fetch() { return Promise.resolve({ json: () => Promise.resolve({}) }); },
        localStorage: { getItem() { return null; }, setItem() {}, removeItem() {} },
        navigator: { userAgent: 'node-test' },
        location: { href: 'http://localhost/', search: '', reload() {} },
        // 页面启动即订阅实时同步；harness 不联网，给个惰性 stub
        EventSource: class { constructor() { this.readyState = 0; } close() {} },
        addEventListener() {},
        removeEventListener() {},
        document: {
            getElementById(id) { return els[id] || (els[id] = makeEl()); },
            querySelector() { return null; },
            querySelectorAll() { return []; },
            addEventListener() {},
            createElement() { return makeEl(); },
            documentElement: { dataset: {} },
            body: makeEl(),
            title: '',
        },
        window: null,
    };
    sandbox.window = sandbox;
    sandbox.globalThis = sandbox;
    return sandbox;
}

const html = fs.readFileSync(path.join(ROOT, 'viewer.html'), 'utf-8');
// viewer.html 有多个内联 <script>（head 的皮肤预加载 + 主逻辑），取最长的主逻辑块
const blocks = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map(b => b[1]);
const m = [null, blocks.sort((a, b) => b.length - a.length)[0]];
if (!m[1]) { console.error('未找到内联脚本'); process.exit(1); }

const groups = ['茧房建筑师协会', '猫咪AI研究', '赛博动物园w'];
let failures = 0;

for (const group of groups) {
    const dates = ms.listDates(path.join(ROOT, 'output'), group);
    // 最新日期(切群默认落点)+ 全部日期抽查
    const targets = process.argv.includes('--all-dates') ? dates : [dates[dates.length - 1]];
    for (const date of targets) {
        const sandbox = buildSandbox();
        vm.createContext(sandbox);
        try {
            // text-utils 通过 <script src> 单独加载(挂 window),sandbox 里也要先灌进去
            vm.runInContext(fs.readFileSync(path.join(ROOT, 'lib/text-utils.js'), 'utf-8'), sandbox, { filename: 'text-utils.js' });
            vm.runInContext(m[1], sandbox, { filename: 'viewer-inline.js' });
            // 注意:内联脚本的 let 声明是词法绑定,不能用 sandbox.xxx= 注入,必须在上下文内赋值
            const msgs = ms.loadMessagesByDate(path.join(ROOT, 'output'), group, date);
            sandbox.__msgs = msgs;
            vm.runInContext(`allMessages = __msgs; selectedDate = ${JSON.stringify(date)};`, sandbox);
            if (process.argv.includes('--no-noise-filter')) vm.runInContext('hideNoise = false', sandbox);
            vm.runInContext('renderAll()', sandbox);
            const len = vm.runInContext("document.getElementById('messages').innerHTML.length", sandbox);
            if (msgs.length && len < 100) throw new Error(`渲染结果异常空(html ${len} 字,消息 ${msgs.length} 条)`);
        } catch (e) {
            failures++;
            console.error(`✗ ${group} ${date}: ${e.message}`);
            continue;
        }
        if (!process.argv.includes('--all-dates')) console.log(`✓ ${group} ${date} 渲染正常`);
    }
}
console.log(failures ? `\n${failures} 个日期渲染崩溃` : '\n全部通过');
process.exit(failures ? 1 : 0);
