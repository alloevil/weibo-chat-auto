const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const html = fs.readFileSync(path.join(__dirname, '../viewer.html'), 'utf8');
const source = html.slice(
    html.indexOf('function canEnterSearchResults('),
    html.indexOf('function isCombinedSearch(')
);
function harness() {
    const frames = [];
    const panel = {
        dataset: { view: 'search' },
        visible: true,
        classList: { contains: () => panel.visible },
    };
    const controls = { open: true };
    const feedback = { textContent: '', hidden: true };
    let focused = 0;
    const elements = {
        researchPanel: panel,
        combinedSearchControls: controls,
        combinedSearchFeedback: feedback,
        searchResultSummary: { focus: () => focused++ },
    };
    const context = vm.createContext({
        document: { getElementById: (id) => elements[id] },
        window: { matchMedia: () => ({ matches: context.narrow }) },
        isCombinedSearch: () => context.combined,
        narrow: true,
        combined: true,
        searchRevision: 7,
        searchInteractionRevision: 2,
        currentGroup: 'synthetic',
        requestAnimationFrame: (callback) => frames.push(callback),
    });
    vm.runInContext(source, context);
    return {
        context,
        panel,
        controls,
        feedback,
        frames,
        focused: () => focused,
        token: { revision: 7, interaction: 2, group: 'synthetic' },
    };
}
test('手机转场：仅窄屏、当前组合请求且条件区与搜索面板打开时允许', () => {
    const { context, token, controls, panel } = harness();
    assert.equal(context.canEnterSearchResults(token), true);
    assert.equal(context.canEnterSearchResults(null), false);
    for (const patch of [{ revision: 6 }, { interaction: 1 }, { group: 'other' }])
        assert.equal(context.canEnterSearchResults({ ...token, ...patch }), false);
    context.narrow = false;
    assert.equal(context.canEnterSearchResults(token), false);
    context.narrow = true;
    context.combined = false;
    assert.equal(context.canEnterSearchResults(token), false);
    context.combined = true;
    controls.open = false;
    assert.equal(context.canEnterSearchResults(token), false);
    controls.open = true;
    panel.visible = false;
    assert.equal(context.canEnterSearchResults(token), false);
    panel.visible = true;
    panel.dataset.view = 'members';
    assert.equal(context.canEnterSearchResults(token), false);
});
test('手机转场：成功收起，布局帧之后才聚焦摘要', async () => {
    const { context, token, controls, frames, focused } = harness();
    const completion = context.enterSearchResults(token);
    assert.equal(controls.open, false);
    assert.equal(focused(), 0);
    frames.shift()();
    frames.shift()();
    await completion;
    assert.equal(focused(), 1);
});
test('手机转场：布局帧之间编辑、换群、换请求、重开、关闭或换面板均不抢焦点', async () => {
    const changes = [
        (state) => state.context.searchInteractionRevision++,
        (state) => (state.context.currentGroup = 'other'),
        (state) => state.context.searchRevision++,
        (state) => (state.controls.open = true),
        (state) => (state.panel.visible = false),
        (state) => (state.panel.dataset.view = 'members'),
    ];
    for (const change of changes) {
        const state = harness();
        const completion = state.context.enterSearchResults(state.token);
        change(state);
        state.frames.shift()();
        state.frames.shift()();
        await completion;
        assert.equal(state.focused(), 0);
    }
});
test('手机转场：无资格不收起，表单反馈可见且能清除', async () => {
    const { context, controls, frames, feedback } = harness();
    await context.enterSearchResults(null);
    assert.equal(controls.open, true);
    assert.equal(frames.length, 0);
    context.searchFormFeedback('检索失败');
    assert.equal(feedback.hidden, false);
    assert.equal(feedback.textContent, '检索失败');
    context.searchFormFeedback();
    assert.equal(feedback.hidden, true);
    assert.equal(feedback.textContent, '');
});
