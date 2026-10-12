const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const html = fs.readFileSync(path.join(__dirname, '../viewer.html'), 'utf8');
const input = html.match(/<input\b[^>]*id="searchMemberFragment"[^>]*>/)[0];
const handler = input.match(/onkeydown="([^"]*)"/)[1];

function dispatch(properties) {
    let focused = 'searchMemberFragment';
    let prevented = 0;
    const context = vm.createContext({
        event: { ...properties, preventDefault: () => prevented++ },
        document: {
            getElementById: (id) => {
                assert.equal(id, 'searchMember');
                return {
                    focus: () => {
                        focused = id;
                    },
                };
            },
        },
    });
    vm.runInContext(handler, context);
    return { focused, prevented };
}

for (const properties of [
    { key: 'Enter', isComposing: true, keyCode: 13 },
    { key: 'Enter', isComposing: false, keyCode: 229 },
    { key: 'Enter', isComposing: true, keyCode: 229 },
]) {
    test(`昵称Enter组字保护 ${JSON.stringify(properties)}`, () => {
        assert.deepEqual(dispatch(properties), { focused: 'searchMemberFragment', prevented: 0 });
    });
}

test('昵称非组字Enter保留阻止表单默认行为并聚焦成员选择', () => {
    assert.deepEqual(dispatch({ key: 'Enter', isComposing: false, keyCode: 13 }), {
        focused: 'searchMember',
        prevented: 1,
    });
});

test('昵称Escape不进入普通Enter行为', () => {
    assert.deepEqual(dispatch({ key: 'Escape', isComposing: true, keyCode: 27 }), {
        focused: 'searchMemberFragment',
        prevented: 0,
    });
});
