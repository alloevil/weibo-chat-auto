const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const html = fs.readFileSync(path.join(__dirname, '../viewer.html'), 'utf8');
const source = html.slice(
    html.indexOf('function updateContextLoadStatus('),
    html.indexOf('function renderContext(session,')
);
function button(attributes, textContent) {
    const values = new Map(Object.entries(attributes));
    return {
        textContent,
        get attributes() {
            return [...values].map(([name, value]) => ({ name, value }));
        },
        hasAttribute: (name) => values.has(name),
        setAttribute: (name, value) => values.set(name, value),
        removeAttribute: (name) => values.delete(name),
        getAttribute: (name) => values.get(name),
        remove() {
            this.parent.button = null;
        },
    };
}
function row(date, text, control) {
    const element = {
        dataset: { loadDate: date },
        firstChild: { textContent: text },
        button: control,
        querySelector() {
            return this.button;
        },
        appendChild(child) {
            this.button = child;
            child.parent = this;
        },
        remove() {
            this.parent.children = this.parent.children.filter((child) => child !== this);
        },
    };
    if (control) control.parent = element;
    return element;
}
function harness() {
    let replacements = [];
    const container = {
        children: [],
        hidden: true,
        set innerHTML(_value) {
            this.children = [];
        },
        appendChild(element) {
            this.children.push(element);
            element.parent = this;
        },
    };
    const document = {
        activeElement: null,
        getElementById: () => container,
        createElement: () => ({
            set innerHTML(_value) {},
            content: {
                get children() {
                    return replacements;
                },
            },
        }),
    };
    const context = vm.createContext({ document });
    vm.runInContext(source, context);
    return {
        container,
        document,
        render(session, rows) {
            replacements = rows;
            context.updateContextLoadStatus(session, 'synthetic markup');
        },
    };
}

test('显式继续的状态更新复用按钮节点，等待/成功不丢焦点且不能再激活', () => {
    const state = harness();
    const session = {};
    const original = button(
        { 'data-continue-date': '2026-09-20', onclick: 'continueContextDay()' },
        '继续读取'
    );
    state.render(session, [row('2026-09-20', '尚未完成', original)]);
    state.document.activeElement = original;
    state.render(session, [
        row(
            '2026-09-20',
            '读取中',
            button({ 'data-continue-date': '2026-09-20', 'aria-disabled': 'true' }, '读取中…')
        ),
    ]);
    assert.equal(state.container.children[0].button, original);
    assert.equal(state.document.activeElement, original);
    assert.equal(original.hasAttribute('onclick'), false);
    assert.equal(original.hasAttribute('disabled'), false);
    assert.equal(original.getAttribute('aria-disabled'), 'true');
    state.render(session, [
        row('2026-09-20', '完成', button({ 'aria-disabled': 'true' }, '已完成读取')),
    ]);
    assert.equal(state.container.children[0].button, original);
    assert.equal(original.textContent, '已完成读取');
    assert.equal(state.container.hidden, false);
});

test('同一按钮错误时原位变为可重试，不抢用户已经移走的焦点', () => {
    const state = harness();
    const session = {};
    const original = button({ 'aria-disabled': 'true' }, '读取中');
    state.render(session, [row('2026-09-20', '读取中', original)]);
    const other = {};
    state.document.activeElement = other;
    state.render(session, [
        row(
            '2026-09-20',
            '加载失败',
            button({ 'data-retry-date': '2026-09-20', onclick: 'retryContextDay()' }, '重试')
        ),
    ]);
    assert.equal(state.container.children[0].button, original);
    assert.equal(original.getAttribute('onclick'), 'retryContextDay()');
    assert.equal(original.hasAttribute('aria-disabled'), false);
    assert.equal(state.document.activeElement, other);
});

test('后台读取无按钮时不制造焦点目标，任务改变不复用旧状态节点', () => {
    const state = harness();
    state.render({}, [row('2026-09-20', '后台读取中', null)]);
    const old = state.container.children[0];
    assert.equal(old.button, null);
    const newSession = {};
    state.render(newSession, [row('2026-09-20', '重试', button({}, '重试'))]);
    assert.notEqual(state.container.children[0], old);
    state.render(newSession, []);
    assert.equal(state.container.hidden, true);
    assert.equal(state.container.children.length, 0);
});
