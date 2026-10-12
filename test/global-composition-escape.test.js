const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const html = fs.readFileSync(path.join(__dirname, '../viewer.html'), 'utf8');
const start = html.indexOf("document.addEventListener('keydown', e => {");
const source = html.slice(start, html.indexOf('let allMessages = [];', start));

function harness(active = [], options = {}) {
    const actions = [];
    let handler;
    const elements = Object.fromEntries(
        ['groupPickerOverlay', 'settingsModal', 'archiveNav', 'lightbox', 'researchPanel'].map(
            (id) => [id, { classList: { contains: () => active.includes(id) } }]
        )
    );
    const menu = {
        open: true,
        querySelector: () => ({ focus: () => actions.push('focus-menu') }),
    };
    const context = vm.createContext({
        codeMode: options.codeMode || false,
        searchQuery: options.searchQuery || '',
        document: {
            addEventListener: (type, callback) => {
                assert.equal(type, 'keydown');
                handler = callback;
            },
            querySelector: () => (active.includes('menu') ? menu : null),
            getElementById: (id) => elements[id] || { focus: () => actions.push(`focus-${id}`) },
        },
        closeGroupPicker: () => actions.push('group'),
        closeSettings: () => actions.push('settings'),
        toggleArchive: (open) => actions.push(`archive-${open}`),
        closeLightbox: () => actions.push('lightbox'),
        closeResearch: () => actions.push('research'),
        isOverlaySidebar: () => !!options.overlay,
        closeTransientPanels: () => actions.push('overlay'),
        clearSearch: () => actions.push('search'),
    });
    vm.runInContext(source, context);
    return {
        menu,
        dispatch: (properties) => {
            handler({
                key: 'Escape',
                keyCode: 27,
                isComposing: false,
                target: { tagName: 'INPUT' },
                preventDefault: () => actions.push('preventDefault'),
                ...properties,
            });
            return actions;
        },
    };
}

for (const marker of [
    { isComposing: true, keyCode: 27 },
    { isComposing: false, keyCode: 229 },
    { isComposing: true, keyCode: 229 },
]) {
    test(`全局Escape组字保护 ${JSON.stringify(marker)}`, () => {
        for (const active of [
            [
                'menu',
                'groupPickerOverlay',
                'settingsModal',
                'archiveNav',
                'lightbox',
                'researchPanel',
            ],
            ['groupPickerOverlay'],
            ['settingsModal'],
            ['archiveNav'],
            ['lightbox'],
            ['researchPanel'],
            [],
        ]) {
            const state = harness(active, { overlay: true, searchQuery: '部署' });
            assert.deepEqual(state.dispatch(marker), []);
            assert.equal(state.menu.open, true);
        }
    });
}

test('普通Escape保留消息菜单先于群选择与其余面板', () => {
    const state = harness(['menu', 'groupPickerOverlay', 'settingsModal', 'researchPanel']);
    assert.deepEqual(state.dispatch({}), ['preventDefault', 'focus-menu']);
    assert.equal(state.menu.open, false);
});

test('普通Escape保留群选择、设置、导航、灯箱、研究面板关闭优先级', () => {
    const order = [
        'groupPickerOverlay',
        'settingsModal',
        'archiveNav',
        'lightbox',
        'researchPanel',
    ];
    const expected = [
        ['preventDefault', 'group'],
        ['settings'],
        ['archive-false', 'focus-archiveNavToggle'],
        ['lightbox'],
        ['research'],
    ];
    for (let index = 0; index < order.length; index++) {
        assert.deepEqual(
            harness(order.slice(index), { overlay: true, searchQuery: '部署' }).dispatch({}),
            expected[index]
        );
    }
});

test('普通Escape仅在上层关闭后处理侧栏和清空搜索，代码模式不退出', () => {
    assert.deepEqual(harness([], { overlay: true, searchQuery: '部署' }).dispatch({}), ['overlay']);
    assert.deepEqual(harness([], { searchQuery: '部署' }).dispatch({}), ['search']);
    assert.deepEqual(harness([]).dispatch({}), []);
    assert.deepEqual(harness(['researchPanel'], { codeMode: true }).dispatch({}), []);
});
