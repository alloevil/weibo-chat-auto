const { test } = require('node:test');
const assert = require('node:assert');
const wa = require('../lib/weibo-auth.js');
const cs = require('../lib/cookie-store.js');

// weibo-auth 是登录判据与会话保活的唯一实现，历史上三处登录检测
// 全靠猜 DOM 而集体失效（见模块头注释）。这里锁死它的行为契约：
// - error_code 21301 = 未鉴权，其它业务码（如 21201 群不存在）= 已鉴权
// - 未登录时绝不吸收 Set-Cookie（防游客 Cookie 污染 cookies.json）
//
// 所有网络与 cookies.json 依赖均被替换：node --test 每个文件独立进程，
// 对 global.fetch / cookie-store 导出对象打补丁不会泄漏到其它测试文件。

/** 构造依次返回给定 error_code 的假 page（Error 项表示 evaluate 抛错）。 */
function fakePage(...codes) {
    let i = 0;
    return {
        evaluate: async () => {
            const c = codes[Math.min(i++, codes.length - 1)];
            if (c instanceof Error) throw c;
            return c;
        },
    };
}

function withFetch(t, impl) {
    const orig = global.fetch;
    global.fetch = impl;
    t.after(() => { global.fetch = orig; });
}

test('probeAuthCode: 在页面上下文取 error_code，缺省为 0', async (t) => {
    // evaluate 直接执行回调，走真实的回调体（fetch → json → error_code || 0）
    const page = { evaluate: (fn, url) => { assert.strictEqual(url, wa.PROBE_PATH); return fn(url); } };
    withFetch(t, async (_url, init) => {
        assert.strictEqual(init.credentials, 'include'); // 同源必须带 Cookie
        return { json: async () => ({ error_code: 21301 }) };
    });
    assert.strictEqual(await wa.probeAuthCode(page), 21301);

    withFetch(t, async () => ({ json: async () => ({ messages: [] }) }));
    assert.strictEqual(await wa.probeAuthCode(page), 0);
});

test('isAuthenticated: 21301 → false，业务错误码/无错误码 → true，探测失败 → null', async () => {
    assert.strictEqual(await wa.isAuthenticated(fakePage(21301)), false);
    assert.strictEqual(await wa.isAuthenticated(fakePage(21201)), true); // 群不存在 = 鉴权已过
    assert.strictEqual(await wa.isAuthenticated(fakePage(0)), true);
    assert.strictEqual(await wa.isAuthenticated(fakePage(new Error('detached frame'))), null);
});

test('waitForAuth: 轮询至鉴权通过', async () => {
    const page = fakePage(21301, 21301, 21201);
    assert.strictEqual(await wa.waitForAuth(page, { timeoutMs: 5000, intervalMs: 1 }), true);
});

test('waitForAuth: 超时返回 false（探测失败也不误报成功）', async () => {
    assert.strictEqual(await wa.waitForAuth(fakePage(21301), { timeoutMs: 8, intervalMs: 3 }), false);
    assert.strictEqual(await wa.waitForAuth(fakePage(new Error('boom')), { timeoutMs: 8, intervalMs: 3 }), false);
});

test('probeAuthCodeHttp: 带 Cookie 打探测端点并取 error_code', async (t) => {
    let captured;
    withFetch(t, async (url, init) => {
        captured = { url: String(url), init };
        return { json: async () => ({ error_code: 21301 }) };
    });
    assert.strictEqual(await wa.probeAuthCodeHttp('SUB=x; SUBP=y'), 21301);
    assert.strictEqual(captured.url, 'https://api.weibo.com' + wa.PROBE_PATH);
    assert.strictEqual(captured.init.headers.Cookie, 'SUB=x; SUBP=y');
    assert.ok(captured.init.signal, '必须带超时 signal，避免探测悬死');

    // 探测自身失败必须向上抛（由调用方决定拦路还是放行），不得吞成某个 code
    withFetch(t, async () => { throw new Error('network down'); });
    await assert.rejects(() => wa.probeAuthCodeHttp('SUB=x'), /network down/);
});

test('refreshSession: 未登录只探测不续期、绝不吸收（防游客 Cookie 污染）', async (t) => {
    const origHeader = cs.cookieHeader;
    const origAbsorb = cs.absorbSetCookies;
    t.after(() => { cs.cookieHeader = origHeader; cs.absorbSetCookies = origAbsorb; });

    cs.cookieHeader = () => 'SUB=dead';
    let absorbed = 0;
    cs.absorbSetCookies = () => { absorbed++; return { ok: true, changed: 9 }; };
    let fetches = 0;
    withFetch(t, async () => { fetches++; return { json: async () => ({ error_code: 21301 }) }; });

    assert.deepStrictEqual(await wa.refreshSession(), { ok: false, code: 21301, renewed: 0 });
    assert.strictEqual(fetches, 1, '21301 后不得再发续期请求');
    assert.strictEqual(absorbed, 0, '未登录时吸收 Set-Cookie 会把游客 Cookie 写进 jar');
});

test('refreshSession: 已登录时向 weibo.com 续期并吸收滚动 Cookie', async (t) => {
    const origHeader = cs.cookieHeader;
    const origAbsorb = cs.absorbSetCookies;
    t.after(() => { cs.cookieHeader = origHeader; cs.absorbSetCookies = origAbsorb; });

    cs.cookieHeader = () => 'SUB=alive';
    let absorbArgs = null;
    cs.absorbSetCookies = (lines, url) => { absorbArgs = { lines, url }; return { ok: true, changed: 2 }; };

    const setCookieLines = ['WBPSESS=new; Domain=.weibo.com; Max-Age=86400', 'XSRF-TOKEN=t; Domain=.weibo.com'];
    withFetch(t, async (url, init) => {
        if (String(url).startsWith('https://api.weibo.com')) {
            return { json: async () => ({ error_code: 21201 }) }; // 业务码 = 已鉴权
        }
        // 续期请求必须伪装成浏览器且不跟随重定向（重定向意味着会话异常）
        assert.match(String(url), /^https:\/\/weibo\.com\//);
        assert.strictEqual(init.headers.Cookie, 'SUB=alive');
        assert.match(init.headers['User-Agent'], /Chrome/);
        assert.strictEqual(init.redirect, 'manual');
        return { headers: { getSetCookie: () => setCookieLines } };
    });

    assert.deepStrictEqual(await wa.refreshSession(), { ok: true, code: 21201, renewed: 2 });
    assert.deepStrictEqual(absorbArgs.lines, setCookieLines);
    assert.match(absorbArgs.url, /weibo\.com/);
});
