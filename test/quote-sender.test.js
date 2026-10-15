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
    assert.match(result, /class="quote-sender-name">合成原发送人：<\/span>/);
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

test('长引用默认折叠时，发送人线索仍在summary里，原文不截断', () => {
    const source = { ...original, content: '用于验证长引用完整保留。'.repeat(30) };
    const message = { ...reply, content: `「${source.content}」${separator}收到。` };
    const result = render(message, [source, message]);
    assert.match(
        result,
        /<summary><span class="quote-author"><span class="quote-sender-name">合成原发送人：/
    );
    assert.ok(result.includes(source.content));
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
    assert.match(render(message), /class="quote-author">合成原发送人：<\/span>/);
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
