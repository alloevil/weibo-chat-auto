// 切群流程集成测试:内联脚本跑在 Node sandbox 里,fetch 代理到真实 viewer-server,
// 模拟页面初始化 → switchGroup(),断言消息区/成员区确实切换。
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
const PORT = process.env.WEIBO_PORT || 3996;
const BASE = `http://localhost:${PORT}`;

function makeEl(id) {
    return {
        innerHTML: '', textContent: '', value: '', className: '', id,
        style: {}, dataset: {},
        classList: { add() {}, remove() {}, toggle() {}, contains() { return false; } },
        appendChild() {}, querySelector() { return null; }, querySelectorAll() { return []; },
        addEventListener() {}, scrollIntoView() {}, focus() {},
        scrollTop: 0, scrollHeight: 0, offsetHeight: 0,
        getBoundingClientRect() { return { top: 0, left: 0, width: 0, height: 0 }; },
    };
}

async function main() {
    const els = {};
    const sandbox = {
        console, setTimeout, clearTimeout, setInterval, clearInterval,
        requestAnimationFrame(cb) { cb(); },
        fetch: (url, opts) => fetch(BASE + url, opts),
        localStorage: { getItem() { return null; }, setItem() {}, removeItem() {} },
        navigator: { userAgent: 'node-test' },
        location: { href: BASE + '/', search: '', reload() {} },
        addEventListener() {}, removeEventListener() {},
        document: {
            getElementById(id) { return els[id] || (els[id] = makeEl(id)); },
            querySelector() { return null; },
            querySelectorAll() { return []; },
            addEventListener() {},
            createElement() { return makeEl(''); },
            body: makeEl('body'),
            title: '',
        },
        window: null,
    };
    sandbox.window = sandbox;
    sandbox.globalThis = sandbox;
    vm.createContext(sandbox);

    const html = fs.readFileSync(path.join(ROOT, 'viewer.html'), 'utf-8');
    const script = html.match(/<script>([\s\S]*)<\/script>/)[1];
    // viewer.html 还通过 <script src> 加载 text-utils(挂到 window)
    vm.runInContext(fs.readFileSync(path.join(ROOT, 'lib/text-utils.js'), 'utf-8'), sandbox, { filename: 'text-utils.js' });
    vm.runInContext(script, sandbox, { filename: 'viewer-inline.js' });

    const wait = ms => new Promise(r => setTimeout(r, ms));

    // 页面初始化
    await vm.runInContext('loadData()', sandbox);
    await wait(300);
    const g1 = vm.runInContext('currentGroup', sandbox);
    const date1 = vm.runInContext('selectedDate', sandbox);
    const msgs1 = els['messages'].innerHTML;
    const users1 = els['userList'].innerHTML;
    console.log(`初始: group=${g1} date=${date1} msgs=${msgs1.length}字 users=${users1.length}字`);

    // 切群
    const target = g1 === '猫咪AI研究' ? '赛博动物园w' : '猫咪AI研究';
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
    if (usersChanged && !msgsChanged) { console.log('*** 复现 bug:成员切换但消息未切换 ***'); process.exit(2); }
    if (!msgsChanged) { console.log('*** 消息区未变化 ***'); process.exit(1); }
    console.log('切群流程正常');
}

main().catch(e => { console.error('harness 异常:', e); process.exit(1); });
