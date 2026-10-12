const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const html = fs.readFileSync(path.join(__dirname, '../viewer.html'), 'utf8');
const code = html.slice(
    html.indexOf('let contextReturnTask = null;'),
    html.indexOf('function contextDayMessages(')
);
function setup() {
    const fields = {};
    const element = (id) =>
        (fields[id] ||= {
            value: '',
            textContent: '',
            hidden: false,
            disabled: false,
            scrollTop: 19,
            classList: { contains: () => false },
        });
    const api = vm.createContext({
        document: {
            getElementById: element,
            querySelectorAll: () => [{ open: true }, { open: false }],
        },
        currentGroup: 'g',
        archiveRevision: 1,
        selectedDate: '2026-09-20',
        selectedMonth: '2026-09',
        allMessages: [{ id: 'source' }],
        selectedHours: new Set([23]),
        selectedUsers: new Set(['name']),
        mediaFilter: 'all',
        hideNoise: false,
        mentionOnly: false,
        searchQuery: '',
        globalSearchQuery: '',
        combinedSearch: { fromUid: '' },
        saveReadingPosition: () => {},
    });
    vm.runInContext(code, api);
    const session = {
        group: 'g',
        archive: 1,
        date: '2026-09-20',
        id: 'source',
        cache: new Map([
            ['2026-09-20', [{ id: 'source' }]],
            ['2026-09-21', [{ id: 'a' }, { id: 'b' }]],
        ]),
        pending: new Set(),
        failed: new Set(),
        loading: false,
    };
    return { api, session, fields, task: () => vm.runInContext('contextReturnTask', api) };
}
test('上下文返回仅保存本群单层快照，后续来源不能覆盖或堆叠', () => {
    const state = setup();
    state.api.captureContextReturn(state.session, 0);
    const first = state.task();
    assert.equal(first.session.id, 'source');
    assert.equal(first.selectedIndex, 0);
    assert.equal(first.contextScroll, 19);
    assert.deepEqual(Array.from(first.details), [true, false]);
    state.api.captureContextReturn({ ...state.session, id: 'different' }, 1);
    assert.equal(state.task(), first);
    assert.notEqual(first.session.cache, state.session.cache);
    state.api.discardContextReturn();
    assert.equal(state.task(), null);
    assert.equal(state.fields.contextReturnBar.hidden, true);
});

test('正反向共用单层快照，候选类型和首个来源不被后续交叉覆盖', () => {
    for (const kind of ['forward', 'reverse']) {
        const state = setup();
        state.api.captureContextReturn(state.session, 1, kind);
        const original = state.task();
        assert.equal(original.candidateKind, kind);
        state.api.captureContextReturn(
            { ...state.session, id: 'next-source' },
            0,
            kind === 'forward' ? 'reverse' : 'forward'
        );
        assert.equal(state.task(), original);
        assert.equal(original.session.id, 'source');
        assert.equal(original.selectedIndex, 1);
    }
});
test('上下文快照拒绝跨群/旧revision，保留已加载内容但不复用在途请求', () => {
    const state = setup();
    state.api.captureContextReturn({ ...state.session, group: 'other' }, 0);
    assert.equal(state.task(), null);
    state.api.captureContextReturn({ ...state.session, archive: 0 }, 0);
    assert.equal(state.task(), null);
    state.session.pending.add('2026-09-22');
    state.session.failed.add('2026-09-19');
    state.session.interrupted = new Set(['2026-09-18']);
    state.api.captureContextReturn(state.session, 1);
    const task = state.task();
    assert.equal(task.session.pending.size, 0);
    assert.equal(task.session.failed.has('2026-09-22'), false);
    assert.equal(task.session.interrupted.has('2026-09-22'), true);
    assert.equal(task.session.interrupted.has('2026-09-18'), true);
    assert.deepEqual([...task.session.failed], ['2026-09-19']);
    assert.equal(task.session.loading, false);
});
test('上下文返回用户触发前不执行，跨群或已恢复状态不进入读取', async () => {
    const state = setup();
    await state.api.returnToReferenceContext();
    state.api.captureContextReturn(state.session, 0);
    state.api.currentGroup = 'other';
    await state.api.returnToReferenceContext();
    assert.equal(state.task().restoring, false);
    state.api.currentGroup = 'g';
    state.task().restoring = true;
    await state.api.returnToReferenceContext();
    assert.equal(state.task().restoring, true);
});

for (const kind of ['forward', 'reverse']) {
    test(`上下文返回${kind}使用缓存且不改搜索/AI任务对象，恢复展开位置并消费单层快照`, async () => {
        const state = setup();
        const frames = [];
        const reads = [];
        const classes = new Set();
        let focused = false;
        const details = [{ open: true }, { open: false }];
        const task = { kind: 'ai', question: '保留问答' };
        state.api.readingTask = task;
        state.api.ctxSession = null;
        state.api.document.querySelector = () => ({
            classList: { add: (name) => classes.add(name), remove: (name) => classes.delete(name) },
        });
        state.api.document.querySelectorAll = (selector) =>
            selector ===
            (kind === 'forward' ? '.ctx-reference-candidate' : '.ctx-reverse-candidate')
                ? [
                      {
                          focus: () => {
                              focused = true;
                          },
                      },
                  ]
                : details;
        state.api.closeResearch = () => {
            state.api.ctxSession = null;
        };
        state.api.syncSearchControls = () => {};
        state.api.renderCalendar = () => {};
        state.api.renderContext = () => {};
        state.api.loadMessages = async (preserve, messages) => reads.push({ preserve, messages });
        state.api.requestAnimationFrame = (callback) => frames.push(callback);
        state.api.document.getElementById('contextPanel').classList.toggle = () => {};
        state.api.document.getElementById('ctxDensityBtn').setAttribute = () => {};
        state.api.captureContextReturn(state.session, 0, kind);
        const snapshot = state.task();
        const restoring = state.api.returnToReferenceContext();
        await new Promise((resolve) => setTimeout(resolve, 0));
        assert.equal(reads.length, 1);
        assert.equal(reads[0].messages, snapshot.messages);
        assert.equal(state.api.readingTask, task);
        assert.equal(state.task(), null);
        frames.shift()();
        frames.shift()();
        await restoring;
        assert.equal(focused, true);
        assert.equal(state.fields.contextBody.scrollTop, 19);
        assert.equal(state.api.ctxSession.id, 'source');
        assert.equal(state.api.ctxSession.archive, 2);
        assert.deepEqual(
            details.map((element) => element.open),
            [true, false]
        );
        assert.equal(classes.has('task-restoring'), false);
    });
}

test('清空搜索默认清理上下文，内部线索清空显式保留', () => {
    const state = setup();
    const clearBody = html.slice(
        html.indexOf('function clearSearch(render = true,'),
        html.indexOf('// ── 「提到我」')
    );
    state.api.resetSearchComposition = () => {};
    state.api.searchFormFeedback = () => {};
    state.api.discardReadingTask = () => {};
    state.api.clearTimeout = () => {};
    state.api.searchDebounceTimer = null;
    state.api.globalSearchTimer = null;
    state.api.searchRevision = 1;
    state.api.syncSearchControls = () => {};
    state.api.closeSearchResults = () => {};
    state.api.renderAll = () => {};
    state.api.isCombinedSearch = () => false;
    state.api.document.getElementById('searchAllHint').dataset = {};
    vm.runInContext(clearBody, state.api);
    state.api.captureContextReturn(state.session, 0);
    const original = state.task();
    state.api.clearSearch(false, true);
    assert.equal(state.task(), original);
    state.api.clearSearch();
    assert.equal(state.task(), null);
});

test('恢复在途切群并清理快照后，旧缓存完成不重开上下文', async () => {
    const state = setup();
    let finishLoad;
    let renderCount = 0;
    state.api.document.querySelector = () => ({ classList: { add() {}, remove() {} } });
    state.api.closeResearch = () => {
        state.api.ctxSession = null;
    };
    state.api.syncSearchControls = () => {};
    state.api.renderContext = () => renderCount++;
    state.api.loadMessages = () =>
        new Promise((resolve) => {
            finishLoad = resolve;
        });
    state.api.captureContextReturn(state.session, 0);
    const restoring = state.api.returnToReferenceContext();
    assert.equal(state.task().restoring, true);
    state.api.discardContextReturn();
    state.api.currentGroup = 'other';
    state.api.archiveRevision++;
    finishLoad();
    await restoring;
    assert.equal(state.api.ctxSession, null);
    assert.equal(state.task(), null);
    assert.equal(renderCount, 0);
});
