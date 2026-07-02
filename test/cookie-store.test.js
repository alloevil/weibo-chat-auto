const { test } = require('node:test');
const assert = require('node:assert');
const cs = require('../lib/cookie-store.js');

test('hasLoginCookie 仅在存在 SUB 时为真', () => {
    assert.strictEqual(cs.hasLoginCookie([{ name: 'SUB', value: 'x' }]), true);
    assert.strictEqual(cs.hasLoginCookie([{ name: 'SUBP', value: 'x' }, { name: 'ULV', value: 'y' }]), false);
    assert.strictEqual(cs.hasLoginCookie([]), false);
    assert.strictEqual(cs.hasLoginCookie(null), false);
});

test('normalizeDomains 补前导点，已有点/无点域名不重复处理', () => {
    const arr = [
        { name: 'SUB', domain: 'weibo.com' },
        { name: 'A', domain: '.weibo.com' },
        { name: 'B', domain: 'localhost' }, // 无点主机名不加
        { name: 'C' },                       // 无 domain 字段不崩
    ];
    cs.normalizeDomains(arr);
    assert.strictEqual(arr[0].domain, '.weibo.com');
    assert.strictEqual(arr[1].domain, '.weibo.com');
    assert.strictEqual(arr[2].domain, 'localhost');
});

test('saveCookies 无 SUB 时拒绝（不落盘）', () => {
    // 只有失效会话（无 SUB）会触发拒绝分支，这条路径不写文件，可安全直测
    const r = cs.saveCookies([{ name: 'ULV', value: 'x', domain: '.weibo.com' }], '单测');
    assert.strictEqual(r.ok, false);
    assert.match(r.error, /SUB/);
});

test('cookieHeader 序列化为请求头格式', () => {
    assert.strictEqual(
        cs.cookieHeader([{ name: 'a', value: '1' }, { name: 'b', value: '2' }]),
        'a=1; b=2'
    );
});
