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
    const impl = fakeFetch({ result: true, id: 5329279252433540 });
    const r = await sm.sendGroupMessage({ groupId: '123', content: '  你好  ', cookieHeader: 'SUB=x', fetchImpl: impl });

    assert.strictEqual(r.ok, true);
    assert.strictEqual(r.messageId, '5329279252433540', '成功需透出已创建消息 id');
    const { url, init } = impl.calls[0];
    assert.strictEqual(url, 'https://api.weibo.com' + sm.SEND_PATH);
    assert.strictEqual(init.method, 'POST');
    assert.strictEqual(init.headers['Content-Type'], 'application/x-www-form-urlencoded');
    assert.strictEqual(init.headers.Cookie, 'SUB=x');
    const params = new URLSearchParams(init.body);
    assert.strictEqual(params.get('id'), '123');
    assert.strictEqual(params.get('content'), '你好', '内容需 trim 后发送');
    assert.strictEqual(params.get('source'), '209678993');
    assert.strictEqual(params.get('media_type'), '0');
    assert.ok(init.signal, '必须带超时 signal');

    // 客户端标记不可省：实测缺 annotations 时接口回成功、消息随即被风控撤回，
    // 群里只剩一条"你撤回了一条消息"。return_detail 让投递结果可确定判断。
    assert.deepStrictEqual(JSON.parse(params.get('annotations')), { webchat: 1, clientid: '' });
    assert.strictEqual(params.get('return_detail'), '1');
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
// ── 发图（两步：uploadx 取 fid → send_message 带 fids + media_type=1）──

function uploadThenSend({ upload, send }) {
    const calls = [];
    const impl = async (url, init) => {
        const u = String(url);
        calls.push({ url: u, init });
        const body = u.includes(sm.UPLOAD_PATH) ? upload : send;
        return { status: 200, ok: true, json: async () => body };
    };
    impl.calls = calls;
    return impl;
}

test('sendGroupImage: 先 multipart 上传取 fid，再带 fids + media_type=1 发送', async () => {
    const impl = uploadThenSend({ upload: { fid: 'FID123' }, send: { result: true, id: 999 } });
    const r = await sm.sendGroupImage({
        groupId: '123', buffer: Buffer.from([137, 80, 78, 71]), filename: 'a.png',
        mimeType: 'image/png', cookieHeader: 'SUB=x', fetchImpl: impl,
    });

    assert.deepStrictEqual([r.ok, r.fid, r.messageId], [true, 'FID123', '999']);
    assert.strictEqual(impl.calls.length, 2, '必须是上传 + 发送两步');

    const [up, send] = impl.calls;
    assert.match(up.url, new RegExp(sm.UPLOAD_PATH.replace(/\//g, '\\/')));
    assert.ok(up.init.body instanceof FormData, '上传必须是 multipart');
    assert.ok(!('Content-Type' in up.init.headers), 'boundary 交给 fetch 生成，不能手写 Content-Type');

    const params = new URLSearchParams(send.init.body);
    assert.strictEqual(params.get('fids'), 'FID123');
    assert.strictEqual(params.get('media_type'), '1');
    assert.strictEqual(params.get('content'), '分享图片', '与真实客户端一致的文案');
    assert.deepStrictEqual(JSON.parse(params.get('annotations')), { webchat: 1, clientid: '' },
        '发图同样需要客户端标记，否则被风控静默撤回');
});

test('sendGroupImage: 上传未返回 fid 时不发消息', async () => {
    const impl = uploadThenSend({ upload: { result: false, error: '存储异常' }, send: { result: true } });
    const r = await sm.sendGroupImage({ groupId: '1', buffer: Buffer.from([1]), cookieHeader: 'c', fetchImpl: impl });
    assert.strictEqual(r.ok, false);
    assert.match(r.error, /fid/);
    assert.strictEqual(impl.calls.length, 1, '拿不到 fid 就不该继续发送');
});

test('sendGroupImage: 上传遇 21301 → needLogin', async () => {
    const impl = uploadThenSend({ upload: { error_code: 21301 }, send: {} });
    const r = await sm.sendGroupImage({ groupId: '1', buffer: Buffer.from([1]), cookieHeader: 'c', fetchImpl: impl });
    assert.deepStrictEqual([r.ok, r.needLogin], [false, true]);
});

test('sendGroupImage: 空图/超大图/缺 groupId 本地即拦，不打接口', async () => {
    let called = 0;
    const impl = async () => { called++; return { status: 200, json: async () => ({}) }; };
    assert.match((await sm.sendGroupImage({ groupId: '', buffer: Buffer.from([1]), cookieHeader: 'c', fetchImpl: impl })).error, /会话 id/);
    assert.match((await sm.sendGroupImage({ groupId: '1', buffer: Buffer.alloc(0), cookieHeader: 'c', fetchImpl: impl })).error, /为空/);
    assert.match((await sm.sendGroupImage({ groupId: '1', buffer: Buffer.alloc(sm.MAX_IMAGE_BYTES + 1), cookieHeader: 'c', fetchImpl: impl })).error, /过大/);
    assert.strictEqual(called, 0);
});

test('sendGroupImage: 上传本身抛错时给出可读原因', async () => {
    const r = await sm.sendGroupImage({
        groupId: '1', buffer: Buffer.from([1]), cookieHeader: 'c',
        fetchImpl: async () => { throw new Error('socket hang up'); },
    });
    assert.strictEqual(r.ok, false);
    assert.match(r.error, /上传失败.*socket hang up/);
});

test('sendGroupMessage: 不传 mediaType 时保持纯文本行为（无 fids 字段）', async () => {
    const impl = fakeFetch({ result: true, id: 1 });
    await sm.sendGroupMessage({ groupId: '1', content: 'hi', cookieHeader: 'c', fetchImpl: impl });
    const params = new URLSearchParams(impl.calls[0].init.body);
    assert.strictEqual(params.get('media_type'), '0');
    assert.strictEqual(params.get('fids'), null, '文本消息不该带 fids');
});
