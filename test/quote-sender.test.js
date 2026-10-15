const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const textUtils = require('../lib/text-utils');

const html = fs.readFileSync(path.join(__dirname, '../viewer.html'), 'utf8');
const separator = ' - - - - - - - - - - - - - - - ';
const original = {
    id: 'original',
    date: '2026-10-14',
    user: '合成原发送人',
    from_uid: 'one',
    content: '先核对部署方案，再保留回滚记录。',
};
const reply = {
    id: 'reply',
    date: original.date,
    user: '合成回复人',
    from_uid: 'two',
    content: `「${original.content}」${separator}收到。`,
};

function render(message = reply, messages = [original, reply]) {
    const context = vm.createContext({
        ...textUtils,
        allMessages: messages,
        selectedDate: original.date,
        currentGroup: 'synthetic',
        resolveEmoji: () => null,
    });
    vm.runInContext(
        html.slice(
            html.indexOf('function contextQuoteText('),
            html.indexOf('function renderContextReference(')
        ),
        context
    );
    const start = html.includes('function renderQuoteSender(')
        ? html.indexOf('function renderQuoteSender(')
        : html.indexOf('function processForward(');
    vm.runInContext(html.slice(start, html.indexOf('function closeMessageMenus(')), context);
    return context.processForward(message.content, message);
}

test('唯一候选显示姓名，未确认说明收进问号和默认隐藏的文字', () => {
    const result = render();
    assert.match(result, /class="quote-sender-name" style="[^"]+">合成原发送人：<\/span>/);
    assert.match(result, /class="quote-sender-help"/);
    assert.match(result, /class="quote-sender-note" hidden>根据原文文本匹配，发送人尚未确认/);
    assert.doesNotMatch(result, /引用候选发送人|引用发送人：/);
    assert.ok(result.includes('>核对原文</button>'));
    assert.ok(result.includes('文本匹配不确认来源'));
    assert.doesNotMatch(result, /jumpToMessage/);
});

test('同文多来源显示待确认，详情保留姓名和数量，不合并同名不同ID', () => {
    const result = render(reply, [
        original,
        { ...original, id: 'other', user: '另一位发送人', from_uid: 'other' },
        reply,
    ]);
    assert.match(result, /合成原发送人/);
    assert.match(result, /quote-sender-name">发送人待确认/);
    assert.match(result, /另一位发送人/);
    assert.match(result, /2 条同文候选/);
    const sameName = render(reply, [
        original,
        { ...original, id: 'other', from_uid: 'other' },
        reply,
    ]);
    assert.match(sameName, /2 条同文候选/);
});

test('未找到引用来源时明确未定位，不能把回复人或@提及当原发送人', () => {
    const message = { ...reply, content: `「没有匹配原文」${separator}@另一位 收到。` };
    const result = render(message, [message]);
    assert.match(result, /quote-sender-name">发送人待确认/);
    assert.match(result, /本日归档未定位原文/);
    assert.doesNotMatch(result, /quote-author[^>]*>[^<]*(合成回复人|另一位)/);
});

test('长引用默认完整展开，发送人线索和原文保留，仍可主动收起', () => {
    const source = { ...original, content: '用于验证长引用完整保留。'.repeat(30) };
    const message = { ...reply, content: `「${source.content}」${separator}收到。` };
    const result = render(message, [source, message]);
    assert.match(result, /<details class="forward-quote" open>/);
    assert.match(
        result,
        /<summary><span class="quote-author"><span class="quote-sender-name" style="[^"]+">合成原发送人：/
    );
    assert.ok(result.includes(source.content));
    const multiline = { ...source, content: '第一行\n第二行\n第三行\n第四行' };
    const multilineReply = { ...reply, content: `「${multiline.content}」${separator}收到` };
    assert.match(
        render(multilineReply, [multiline, multilineReply]),
        /<details class="forward-quote" open>/
    );
    const nested = { ...reply, content: `「${message.content}」${separator}继续回复` };
    const nestedHtml = render(nested, [source, message, nested]);
    assert.equal((nestedHtml.match(/<details class="forward-quote" open>/g) || []).length, 2);
    assert.ok(nestedHtml.includes(source.content));
});

test('显式引用匹配日期ID时显示已核对，冲突不能回退猜作者', () => {
    const message = {
        ...reply,
        reply_to: {
            id: original.id,
            date: original.date,
            from_uid: original.from_uid,
            group: 'synthetic',
        },
    };
    assert.match(
        render(message),
        /class="quote-author"><span class="quote-sender-name" style="[^"]+">合成原发送人：<\/span>/
    );
    assert.doesNotMatch(render(message), /quote-sender-help/);
    const conflict = { ...message, reply_to: { ...message.reply_to, from_uid: 'wrong' } };
    assert.doesNotMatch(render(conflict), /quote-author[^>]*>[^<]*合成原发送人/);
    assert.match(render(conflict), /未定位/);
});

test('姓名必须转义，微博来源标签和普通正文不伪造引用作者', () => {
    const result = render(reply, [{ ...original, user: '<img src=x onerror=alert(1)>' }, reply]);
    assert.match(result, /&lt;img/);
    assert.doesNotMatch(result, /<img src=x/);
    assert.doesNotMatch(render({ ...reply, content: `「微博」${separator}分享` }), /quote-author/);
    assert.doesNotMatch(render({ ...reply, content: '普通正文' }), /quote-author/);
});

test('引用姓名色号按稳定ID分配，不随改名、消息顺序或重复渲染变化', () => {
    const style = (output) => output.match(/class="quote-sender-name" style="([^"]+)"/)[1];
    const expected = style(render());
    assert.equal(style(render(reply, [reply, original])), expected);
    assert.equal(style(render(reply, [{ ...original, user: '改名后的发送人' }, reply])), expected);
    assert.equal(style(render()), expected);
    assert.notEqual(
        style(render(reply, [{ ...original, from_uid: 'another-id' }, reply])),
        expected
    );
});

test('无稳定ID时按昵称回退，数字和字符串ID映射一致', () => {
    const style = (source) =>
        render(reply, [source, reply]).match(/class="quote-sender-name" style="([^"]+)"/)[1];
    assert.equal(style({ ...original, from_uid: null }), style({ ...original, from_uid: '' }));
    assert.equal(style({ ...original, from_uid: 123 }), style({ ...original, from_uid: '123' }));
    assert.notEqual(
        style({ ...original, from_uid: null }),
        style({ ...original, from_uid: null, user: '另一个昵称' })
    );
});

test('多来源、缺来源和无昵称保持中性色，已核对来源沿用同一用户色', () => {
    const ambiguous = render(reply, [
        original,
        { ...original, id: 'duplicate', from_uid: 'another' },
        reply,
    ]);
    assert.doesNotMatch(ambiguous, /--quote-sender-/);
    assert.doesNotMatch(render(reply, [reply]), /--quote-sender-/);
    assert.doesNotMatch(render(reply, [{ ...original, user: '' }, reply]), /--quote-sender-/);
    const verified = render({
        ...reply,
        reply_to: {
            id: original.id,
            date: original.date,
            from_uid: original.from_uid,
            group: 'synthetic',
        },
    });
    assert.equal(verified.match(/style="([^"]+)"/)[1], render().match(/style="([^"]+)"/)[1]);
    assert.doesNotMatch(verified, /quote-sender-help/);
});

test('同一稳定发送人的多条同文消息仍显示姓名和固定颜色，原文关系保持未确认', () => {
    const result = render(reply, [original, { ...original, id: 'repeated' }, reply]);
    assert.match(result, /quote-sender-name" style="[^"]+">合成原发送人：/);
    assert.doesNotMatch(result, /发送人待确认/);
    assert.match(result, /2 条同文候选/);
    assert.match(result, /原文尚未确认/);
    assert.match(result, /quote-sender-help/);
    assert.equal(result.match(/style="([^"]+)"/)[1], render().match(/style="([^"]+)"/)[1]);
});

test('重复归档记录不应使唯一发送人变成待确认，同ID改名仍按身份合并', () => {
    assert.match(
        render(reply, [original, { ...original }, reply]),
        /quote-sender-name" style="[^"]+">合成原发送人：/
    );
    const renamed = render(reply, [
        original,
        { ...original, id: 'renamed', user: '该用户的新昵称' },
        reply,
    ]);
    assert.doesNotMatch(renamed, /发送人待确认/);
    assert.match(renamed, /原文尚未确认/);
});

test('同名但无稳定ID的多条记录仍不能推断为同一个人', () => {
    const noId = { ...original, from_uid: null };
    const result = render(reply, [noId, { ...noId, id: 'other' }, reply]);
    assert.match(result, /quote-sender-name">发送人待确认/);
    assert.doesNotMatch(result, /--quote-sender-/);
    const mixed = render(reply, [original, { ...noId, id: 'unknown-id' }, reply]);
    assert.match(mixed, /quote-sender-name">发送人待确认/);
});
