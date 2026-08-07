const { test } = require('node:test');
const assert = require('node:assert');
const sm = require('../lib/send-message.js');

// 发送侧的关键契约：微博永远回 HTTP 200，失败信息只在 body 里。
// 断言全部对着真实探测到的错误码（21297 缺参 / 21201 群不存在 / 21301 未鉴权）。

function fakeFetch(body, { status = 200, json = true } = {}) {
    const calls = [];
    const impl = async (url, init) => {
        calls.push({ url: String(url), init });
        return {
            status,
            ok: status >= 200 && status < 300,
            json: async () => { if (!json) throw new Error('not json'); return body; },
        };
    };
    impl.calls = calls;
    return impl;
}

test('sendGroupMessage: 请求形状为 form-urlencoded 且带全部必需参数', async () => {
    const impl = fakeFetch({ result: true });
    const r = await sm.sendGroupMessage({ groupId: '123', content: '  你好  ', cookieHeader: 'SUB=x', fetchImpl: impl });

    assert.strictEqual(r.ok, true);
    const { url, init } = impl.calls[0];
    assert.strictEqual(url, 'https://api.weibo.com' + sm.SEND_PATH);
    assert.strictEqual(init.method, 'POST');
    assert.strictEqual(init.headers['Content-Type'], 'application/x-www-form-urlencoded');
    assert.strictEqual(init.headers.Cookie, 'SUB=x');
    const params = new URLSearchParams(init.body);
    assert.strictEqual(params.get('id'), '123');
    assert.strictEqual(params.get('content'), '你好', '内容需 trim 后发送');
    assert.strictEqual(params.get('source'), '209678993');
    assert.ok(init.signal, '必须带超时 signal');
});

test('sendGroupMessage: HTTP 200 + result:false 必须判为失败', async () => {
    // 微博所有失败都是 200，只看 resp.ok 会把失败当成功发出去
    const r = await sm.sendGroupMessage({
        groupId: '1', content: 'x', cookieHeader: 'c',
        fetchImpl: fakeFetch({ result: false, error_code: 21396, error: '发送太频繁' }),
    });
    assert.strictEqual(r.ok, false);
    assert.strictEqual(r.code, 21396);
    assert.match(r.error, /太频繁/);
});

test('sendGroupMessage: 21301 → needLogin', async () => {
    const r = await sm.sendGroupMessage({
        groupId: '1', content: 'x', cookieHeader: 'c',
        fetchImpl: fakeFetch({ result: false, error_code: 21301, error: 'Auth failed' }),
    });
    assert.deepStrictEqual([r.ok, r.needLogin, r.code], [false, true, 21301]);
});

test('sendGroupMessage: 21201 → 提示会话 id 可能过期', async () => {
    const r = await sm.sendGroupMessage({
        groupId: '0', content: 'x', cookieHeader: 'c',
        fetchImpl: fakeFetch({ result: false, error_code: 21201, error: '群不存在' }),
    });
    assert.strictEqual(r.ok, false);
    assert.match(r.error, /群不存在|会话 id/);
});

test('sendGroupMessage: 缺 groupId / 空内容 / 超长内容不发请求', async () => {
    let called = 0;
    const impl = async () => { called++; return { status: 200, json: async () => ({ result: true }) }; };

    assert.match((await sm.sendGroupMessage({ groupId: '', content: 'x', cookieHeader: 'c', fetchImpl: impl })).error, /会话 id/);
    assert.match((await sm.sendGroupMessage({ groupId: '1', content: '   ', cookieHeader: 'c', fetchImpl: impl })).error, /为空/);
    assert.match((await sm.sendGroupMessage({ groupId: '1', content: 'x'.repeat(sm.MAX_CONTENT + 1), cookieHeader: 'c', fetchImpl: impl })).error, /过长/);
    assert.strictEqual(called, 0, '本地即可判定的错误不得打接口');
});

test('sendGroupMessage: 响应非 JSON 时报错而非当成功', async () => {
    const r = await sm.sendGroupMessage({
        groupId: '1', content: 'x', cookieHeader: 'c',
        fetchImpl: fakeFetch(null, { status: 502, json: false }),
    });
    assert.strictEqual(r.ok, false);
    assert.match(r.error, /502/);
});
