const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const html = fs.readFileSync(path.join(__dirname, '../viewer.html'), 'utf8');
const input = html.match(/<input\b[^>]*id="searchInput"[^>]*>/)[0];
const source = html.slice(
    html.indexOf('let searchComposition = null;'),
    html.indexOf('function onSearchInput(value)')
);

test('正文composition绑定：移除内联，每种事件只注册一次并通过事件进入', () => {
    assert.doesNotMatch(input, /oncomposition(?:start|end)=/);
    const listeners = new Map();
    const timers = new Map([
        [10, () => {}],
        [11, () => {}],
    ]);
    const cancelled = [];
    const searches = [];
    let timerId = 20;
    const element = {
        value: '旧词',
        addEventListener(type, listener) {
            assert.equal(listeners.has(type), false);
            listeners.set(type, listener);
        },
    };
    const context = vm.createContext({
        document: {
            getElementById: (id) => (id === 'searchInput' ? element : { value: 'combined' }),
        },
        globalSearchQuery: '旧词',
        currentGroup: 'synthetic',
        searchRevision: 0,
        searchDebounceTimer: 10,
        globalSearchTimer: 11,
        clearTimeout: (id) => {
            cancelled.push(id);
            timers.delete(id);
        },
        setTimeout: (callback) => {
            const id = timerId++;
            timers.set(id, callback);
            return id;
        },
        onSearchInput: (value) => searches.push(value),
        runGlobalSearch: () => {
            throw new Error('must not submit');
        },
    });
    vm.runInContext(source, context);
    assert.deepEqual(
        [...listeners.keys()],
        ['compositionstart', 'compositionend', 'beforeinput', 'paste', 'cut', 'drop', 'pointerdown']
    );
    const dispatch = (type) => listeners.get(type).call(element, { type, target: element });
    dispatch('compositionstart');
    assert.ok(cancelled.includes(10) && cancelled.includes(11));
    assert.equal(context.searchRevision, 1);
    element.value = '部署';
    context.handleSearchInput({ target: element, isComposing: true });
    assert.deepEqual(searches, []);
    dispatch('compositionend');
    element.value = '部署 回滚';
    context.handleSearchInput({ target: element, isComposing: false });
    for (const callback of timers.values()) callback();
    assert.deepEqual(searches, ['部署 回滚']);
});
