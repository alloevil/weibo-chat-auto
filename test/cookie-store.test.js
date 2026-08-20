const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

// 落盘测试需要真实写文件：先把 Cookie 文件指到临时目录再加载模块
// （node --test 每个文件独立进程，env 不会泄漏到其它测试文件）。
const TEST_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'cookie-store-test-'));
process.env.WEIBO_COOKIE_FILE = path.join(TEST_DIR, 'cookies.json');
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

test('saveCookies 落盘权限为 0600，覆盖已存在的宽权限文件也收紧', () => {
    // 新建：writeFileSync 的 mode 生效
    const r1 = cs.saveCookies([{ name: 'SUB', value: 'x', domain: '.weibo.com' }], '单测新建');
    assert.strictEqual(r1.ok, true);
    assert.strictEqual(fs.statSync(cs.COOKIE_FILE).mode & 0o777, 0o600);

    // 覆盖：mode 选项对已存在文件不生效，靠 chmod 兜底
    fs.chmodSync(cs.COOKIE_FILE, 0o644);
    const r2 = cs.saveCookies([{ name: 'SUB', value: 'y', domain: '.weibo.com' }], '单测覆盖');
    assert.strictEqual(r2.ok, true);
    assert.strictEqual(fs.statSync(cs.COOKIE_FILE).mode & 0o777, 0o600);
    assert.strictEqual(JSON.parse(fs.readFileSync(cs.COOKIE_FILE, 'utf-8'))[0].value, 'y');
});

test('cookieHeader 序列化为请求头格式', () => {
    assert.strictEqual(
        cs.cookieHeader([{ name: 'a', value: '1' }, { name: 'b', value: '2' }]),
        'a=1; b=2'
    );
});

test('parseSetCookie 解析属性并换算 expires', () => {
    const c = cs.parseSetCookie('ALF=02X9; Domain=.weibo.com; Path=/; Max-Age=3600; Secure; HttpOnly', 'api.weibo.com');
    assert.strictEqual(c.name, 'ALF');
    assert.strictEqual(c.value, '02X9');
    assert.strictEqual(c.domain, '.weibo.com');
    assert.strictEqual(c.secure, true);
    assert.strictEqual(c.httpOnly, true);
    assert.strictEqual(c.session, false);
    const expected = Math.floor(Date.now() / 1000) + 3600;
    assert.ok(Math.abs(c.expires - expected) <= 2);
});

test('parseSetCookie 无 Domain 属性时回退到请求主机', () => {
    const c = cs.parseSetCookie('X=1; Path=/', 'upload.api.weibo.com');
    assert.strictEqual(c.domain, 'upload.api.weibo.com');
    assert.strictEqual(c.session, true);
    assert.strictEqual(c.expires, -1);
});

test('parseSetCookie 拒绝非微博域', () => {
    assert.strictEqual(cs.parseSetCookie('X=1; Domain=.evil.com', 'api.weibo.com'), null);
    assert.strictEqual(cs.parseSetCookie('X=1', 'evil.com'), null);
});

test('parseSetCookie Max-Age 优先于 Expires', () => {
    const c = cs.parseSetCookie('X=1; Expires=Thu, 01 Jan 1970 00:00:00 GMT; Max-Age=100; Domain=.weibo.com', 'weibo.com');
    assert.ok(c.expires > Math.floor(Date.now() / 1000));
});

test('absorbSetCookies 跳过删除指令与无效输入（不落盘）', () => {
    // 空值 / deleted 占位 / 过期时间在过去 → 全部视为删除指令，changed 为 0
    const r = cs.absorbSetCookies([
        'SUB=deleted; Domain=.weibo.com; Expires=Thu, 01 Jan 1970 00:00:00 GMT',
        'SUBP=; Domain=.weibo.com',
        'X=1; Domain=.evil.com',
    ], 'https://api.weibo.com/chat');
    assert.deepStrictEqual(r, { ok: true, changed: 0 });
    assert.deepStrictEqual(cs.absorbSetCookies([], 'https://api.weibo.com'), { ok: true, changed: 0 });
    assert.deepStrictEqual(cs.absorbSetCookies(null, 'https://api.weibo.com'), { ok: true, changed: 0 });
});
