const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const html = fs.readFileSync(path.join(__dirname, '../viewer.html'), 'utf8');
const source = html.slice(
    html.indexOf('function searchMemberChoices('),
    html.indexOf('async function loadSearchMembers(')
);
const members = [
    { id: 'member-007', name: '成员007', names: ['成员007', 'Alpha'] },
    { id: 'member-1007', name: '成员1007', names: ['成员1007'] },
    { id: 'member-2007', name: '成员2007', names: ['成员2007'] },
    { id: 'member-000', name: '同名成员', names: ['同名成员'] },
    { id: 'member-001', name: '同名成员', names: ['同名成员'] },
];
function harness(selectedId = '') {
    const elements = Object.fromEntries(
        [
            'searchMemberFragment',
            'searchMember',
            'memberFragmentCount',
            'clearMemberFragment',
            'searchMemberIdentity',
        ].map((id) => [
            id,
            {
                value: '',
                textContent: '',
                innerHTML: '',
                insertAdjacentHTML(_position, html) {
                    this.innerHTML += html;
                },
            },
        ])
    );
    const context = vm.createContext({
        searchMembers: members,
        combinedSearch: { fromUid: selectedId },
        document: { getElementById: (id) => elements[id] },
        escapeHtml: (value) =>
            String(value)
                .replaceAll('&', '&amp;')
                .replaceAll('<', '&lt;')
                .replaceAll('"', '&quot;'),
    });
    vm.runInContext(source, context);
    return {
        context,
        elements,
        choices: (fragment, selected = selectedId) =>
            context.searchMemberChoices(members, fragment, selected),
    };
}
test('成员候选：007按昵称片段得到三人，不按ID搜索或自动选择', () => {
    const { choices } = harness();
    assert.deepEqual(
        Array.from(choices('007').matches, (member) => member.id),
        ['member-007', 'member-1007', 'member-2007']
    );
    assert.equal(choices('member-007').matches.length, 0);
    assert.equal(choices('007').selected, undefined);
    assert.equal(choices(' alpha ').matches[0].id, 'member-007');
});
test('成员候选：同名不合并稳定ID', () => {
    const { choices } = harness();
    assert.deepEqual(
        Array.from(choices('同名').matches, (member) => member.id),
        ['member-000', 'member-001']
    );
});
test('成员候选：无结果保留已选身份并显式标注，不修改组合条件', () => {
    const { context, elements } = harness('member-007');
    context.filterSearchMembers('不存在');
    assert.equal(context.combinedSearch.fromUid, 'member-007');
    assert.equal(elements.searchMember.value, 'member-007');
    assert.match(elements.searchMember.innerHTML, /已选（不匹配候选词）/);
    assert.match(elements.memberFragmentCount.textContent, /0 \/ 5.*无匹配/);
    assert.match(elements.searchMemberIdentity.textContent, /成员007.*member-007.*选择仍保留/);
});
test('成员候选：清空候选词不移除成员，移除成员不清候选词', () => {
    const { context, elements } = harness('member-007');
    context.filterSearchMembers('同名');
    context.filterSearchMembers('');
    assert.equal(context.combinedSearch.fromUid, 'member-007');
    assert.equal(elements.searchMember.value, 'member-007');
    assert.equal(elements.clearMemberFragment.disabled, true);
    context.filterSearchMembers('007');
    context.combinedSearch.fromUid = '';
    context.renderSearchMemberOptions();
    assert.equal(elements.searchMemberFragment.value, '007');
    assert.equal(elements.searchMember.value, '');
});
test('成员候选：筛选无网络/检索依赖，文字安全转义且未知已选ID保留', () => {
    const { context, elements } = harness('<unknown>');
    context.filterSearchMembers('不存在');
    assert.equal(elements.searchMember.value, '<unknown>');
    assert.match(elements.searchMember.innerHTML, /&lt;unknown>/);
    assert.doesNotMatch(elements.searchMember.innerHTML, /<unknown>/);
});
