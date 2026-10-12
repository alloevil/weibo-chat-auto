const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const html = fs.readFileSync(path.join(__dirname, '../viewer.html'), 'utf8');
const source = html.slice(
    html.indexOf('let searchComposition = null;'),
    html.indexOf('function changeSearchScope()')
);
function harness() {
    let time = 0;
    let nextId = 1;
    const timers = new Map();
    const requests = [];
    const elements = {
        searchInput: { value: '', addEventListener() {} },
        searchScope: { value: 'combined' },
        searchAllHint: { dataset: { payload: '' } },
        searchClear: { className: '' },
    };
    const context = vm.createContext({
        document: { getElementById: (id) => elements[id] },
        currentGroup: 'group-a',
        globalSearchQuery: '',
        searchRevision: 0,
        globalSearchTimer: null,
        searchDebounceTimer: null,
        searchPage: null,
        searchQuery: '',
        combinedSearch: { keywords: '' },
        setTimeout: (callback, delay) => {
            const id = nextId++;
            timers.set(id, { callback, at: time + delay });
            return id;
        },
        clearTimeout: (id) => timers.delete(id),
        searchFormFeedback: () => {},
        discardReadingTask: () => {},
        discardContextReturn: () => {},
        renderAll: () => {},
        showSearchState: () => {},
        isCombinedSearch: () => elements.searchScope.value === 'combined',
        clearSearch: () => {},
        runGlobalSearch: (query) => requests.push(query),
    });
    vm.runInContext(source, context);
    const tick = (duration) => {
        const until = time + duration;
        while (true) {
            const next = [...timers.entries()]
                .filter(([, timer]) => timer.at <= until)
                .sort((left, right) => left[1].at - right[1].at)[0];
            if (!next) break;
            time = next[1].at;
            timers.delete(next[0]);
            next[1].callback();
        }
        time = until;
    };
    const input = (value, isComposing = false) => {
        elements.searchInput.value = value;
        context.handleSearchInput({ target: elements.searchInput, isComposing });
    };
    return { context, elements, requests, tick, input, timers };
}

test('正文组字开始取消旧计时器，暂存input/Enter不更新查询或提交', () => {
    const state = harness();
    state.input('旧词');
    state.tick(100);
    state.context.startSearchComposition();
    state.input('部署', true);
    state.context.searchInputKeydown({
        key: 'Enter',
        isComposing: true,
        keyCode: 229,
        target: state.elements.searchInput,
    });
    state.tick(600);
    assert.deepEqual(state.requests, []);
    assert.equal(state.context.globalSearchQuery, '旧词');
    assert.equal(state.context.combinedSearch.keywords, '旧词');
});

test('正文compositionend与最终input合并，重复最终input不重复请求', () => {
    const state = harness();
    state.context.startSearchComposition();
    state.input('部署', true);
    state.context.endSearchComposition();
    state.input('部署 回滚');
    state.tick(400);
    assert.deepEqual(state.requests, ['部署 回滚']);
    state.input('部署 回滚');
    state.tick(400);
    assert.deepEqual(state.requests, ['部署 回滚']);
});

test('正文完成事件没有最终input时仍按最终值搜索一次', () => {
    const state = harness();
    state.context.startSearchComposition();
    state.input('部署', true);
    state.elements.searchInput.value = '部署 回滚';
    state.context.endSearchComposition();
    state.tick(400);
    assert.deepEqual(state.requests, ['部署 回滚']);
});

test('正文取消组字使用最终确认文本，不提交临时追加内容', () => {
    const state = harness();
    state.input('已确认');
    state.tick(400);
    state.requests.length = 0;
    state.context.startSearchComposition();
    state.input('已确认取消', true);
    state.tick(500);
    state.context.endSearchComposition();
    state.input('已确认');
    state.tick(400);
    assert.deepEqual(state.requests, ['已确认']);
    assert.equal(state.context.globalSearchQuery, '已确认');
});

test('正文普通输入去抖/普通Enter保留，229单独存在时不提交', () => {
    const state = harness();
    state.input('部');
    state.tick(100);
    state.input('部署');
    state.tick(350);
    assert.deepEqual(state.requests, ['部署']);
    state.context.searchInputKeydown({
        key: 'Enter',
        isComposing: false,
        keyCode: 229,
        target: state.elements.searchInput,
    });
    assert.equal(state.requests.length, 1);
    state.context.searchInputKeydown({
        key: 'Enter',
        isComposing: false,
        keyCode: 13,
        target: state.elements.searchInput,
    });
    assert.deepEqual(state.requests, ['部署', '部署']);
});

test('正文组字清空/切群/模式重置撤销旧end和最终input，新键盘输入可恢复', () => {
    for (const kind of ['clear', 'group', 'scope']) {
        const state = harness();
        state.input('原词');
        state.context.startSearchComposition();
        state.input('临时词', true);
        state.context.resetSearchComposition();
        if (kind === 'scope') state.elements.searchScope.value = 'day';
        else {
            state.context.globalSearchQuery = '';
            state.elements.searchInput.value = '';
        }
        if (kind === 'group') state.context.currentGroup = 'group-b';
        state.context.endSearchComposition();
        state.input('旧结束文本');
        state.tick(500);
        assert.deepEqual(state.requests, []);
        assert.equal(state.elements.searchInput.value, kind === 'scope' ? '原词' : '');
        state.context.searchInputKeydown({
            key: 'x',
            isComposing: false,
            keyCode: 88,
            target: state.elements.searchInput,
        });
        state.input('新词');
        state.tick(400);
        assert.deepEqual(state.requests, ['新词']);
    }
});

test('正文完成计时器尚未执行时重置也不恢复旧查询', () => {
    const state = harness();
    state.context.startSearchComposition();
    state.input('部署', true);
    state.context.endSearchComposition();
    state.context.resetSearchComposition();
    state.tick(500);
    assert.deepEqual(state.requests, []);
});

test('完成回调先于最终input：更新提交尾值，延迟同值input只请求一次', () => {
    const state = harness();
    state.context.startSearchComposition();
    state.input('部署', true);
    state.context.endSearchComposition();
    state.tick(0);
    state.input('部署 回滚');
    state.tick(550);
    assert.deepEqual(state.requests, ['部署 回滚']);
    state.input('部署 回滚');
    state.tick(550);
    assert.deepEqual(state.requests, ['部署 回滚']);
});

test('完成后真实编辑新词和键盘同值替换仍请求，不扩大去重到普通输入', () => {
    const state = harness();
    state.context.startSearchComposition();
    state.input('部署', true);
    state.context.endSearchComposition();
    state.input('部署 回滚');
    state.tick(400);
    state.input('部署 回滚 新内容');
    state.tick(400);
    assert.deepEqual(state.requests, ['部署 回滚', '部署 回滚 新内容']);
    state.context.searchInputKeydown({ key: 'a', isComposing: false, keyCode: 65 });
    state.input('部署 回滚 新内容');
    state.tick(400);
    assert.equal(state.requests.length, 3);
});

test('完成后同值粘贴/选择替换和清空后无keydown粘贴均可用', () => {
    for (const type of ['paste', 'drop', 'cut', 'pointerdown']) {
        const state = harness();
        state.context.startSearchComposition();
        state.input('部署', true);
        state.context.endSearchComposition();
        state.input('部署 回滚');
        state.tick(400);
        state.context.prepareSearchEdit({ type });
        state.input('部署 回滚');
        state.tick(400);
        assert.deepEqual(state.requests, ['部署 回滚', '部署 回滚']);
    }
    const state = harness();
    state.context.startSearchComposition();
    state.input('临时', true);
    state.context.resetSearchComposition();
    state.context.prepareSearchEdit({
        type: 'beforeinput',
        inputType: 'insertFromPaste',
        isComposing: false,
    });
    state.input('粘贴');
    state.tick(400);
    assert.deepEqual(state.requests, ['粘贴']);
    state.elements.searchInput.selectionStart = 0;
    state.elements.searchInput.selectionEnd = 2;
    state.context.prepareSearchEdit({
        type: 'beforeinput',
        inputType: 'insertText',
        isComposing: false,
    });
    state.input('粘贴');
    state.tick(400);
    assert.deepEqual(state.requests, ['粘贴', '粘贴']);
});

test('旧组字尾input丢弃后不持续拦截新的无keydown普通输入', () => {
    const state = harness();
    state.context.startSearchComposition();
    state.input('临时', true);
    state.context.resetSearchComposition();
    state.context.endSearchComposition();
    state.input('旧尾事件');
    state.tick(400);
    assert.deepEqual(state.requests, []);
    state.input('新普通输入');
    state.tick(400);
    assert.deepEqual(state.requests, ['新普通输入']);
});
