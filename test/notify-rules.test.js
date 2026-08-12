const { test } = require('node:test');
const assert = require('node:assert');
const nr = require('../lib/notify-rules.js');

const ME = { screenName: '登的厉害', uid: '1710405885' };
const msg = (id, user, content, from_uid = '999') => ({ id, user, content, from_uid, date: '2026-08-12' });

test('mentionsMe: @昵称 命中', () => {
    assert.strictEqual(nr.mentionsMe(msg(1, '张三', '@登的厉害 看一下这个'), ME), true);
    assert.strictEqual(nr.mentionsMe(msg(2, '张三', '前面有字 @登的厉害，后面有标点'), ME), true);
    assert.strictEqual(nr.mentionsMe(msg(3, '张三', '结尾就是 @登的厉害'), ME), true);
});

test('mentionsMe: 昵称裸出现不算（否则闲聊带名字就刷提醒）', () => {
    assert.strictEqual(nr.mentionsMe(msg(4, '张三', '登的厉害这人挺有意思'), ME), false);
});

test('mentionsMe: 不误伤更长的昵称（@登的厉害极了 ≠ @登的厉害）', () => {
    assert.strictEqual(nr.mentionsMe(msg(5, '张三', '@登的厉害极了 你好'), ME), false);
});

test('mentionsMe: 缺昵称或空内容时安全返回 false', () => {
    assert.strictEqual(nr.mentionsMe(msg(6, 'u', '@登的厉害'), { screenName: '' }), false);
    assert.strictEqual(nr.mentionsMe(msg(7, 'u', ''), ME), false);
    assert.strictEqual(nr.mentionsMe(null, ME), false);
});

test('mentionsMe: 昵称含正则元字符不炸', () => {
    const me = { screenName: 'a.b*c', uid: '1' };
    assert.strictEqual(nr.mentionsMe(msg(8, 'u', '@a.b*c 你好'), me), true);
    assert.strictEqual(nr.mentionsMe(msg(9, 'u', '@axbxc 你好'), me), false, '元字符必须被转义');
});

test('matchedKeywords: 大小写不敏感、子串命中、忽略空关键词', () => {
    assert.deepStrictEqual(nr.matchedKeywords(msg(10, 'u', '聊聊 GPU 显卡'), ['gpu', '  ', '']), ['gpu']);
    assert.deepStrictEqual(nr.matchedKeywords(msg(11, 'u', '无关内容'), ['显卡']), []);
});

test('buildNotifications: 提到我优先于关键词，一条消息只产生一条通知', () => {
    const out = nr.buildNotifications(
        [msg(1, '张三', '@登的厉害 说到显卡了')],
        ME, { keywords: ['显卡'], group: '茧房建筑师协会' }
    );
    assert.strictEqual(out.length, 1);
    assert.strictEqual(out[0].kind, 'mention');
    assert.match(out[0].title, /张三.*提到你/);
    assert.match(out[0].title, /茧房建筑师协会/);
});

test('buildNotifications: 自己发的消息永不通知', () => {
    const out = nr.buildNotifications(
        [msg(1, '登的厉害', '@登的厉害 自言自语', ME.uid), msg(2, '登的厉害', '显卡', ME.uid)],
        ME, { keywords: ['显卡'], notifyAll: true }
    );
    assert.deepStrictEqual(out, []);
});

test('buildNotifications: 未命中的消息默认不逐条弹，notifyAll 才汇总一条', () => {
    const batch = [msg(1, 'a', '闲聊一'), msg(2, 'b', '闲聊二'), msg(3, 'c', '闲聊三'), msg(4, 'd', '闲聊四')];
    assert.deepStrictEqual(nr.buildNotifications(batch, ME, {}), [], '默认安静');

    const digest = nr.buildNotifications(batch, ME, { notifyAll: true, group: 'G' });
    assert.strictEqual(digest.length, 1);
    assert.strictEqual(digest[0].kind, 'digest');
    assert.match(digest[0].title, /「G」4 条新消息/);
    assert.strictEqual(digest[0].body.split('\n').length, 3, '摘要只列最近 3 条');
});

test('buildNotifications: 命中的消息不再计入汇总条数', () => {
    const out = nr.buildNotifications(
        [msg(1, 'a', '@登的厉害 在吗'), msg(2, 'b', '闲聊')],
        ME, { notifyAll: true, group: 'G' }
    );
    assert.deepStrictEqual(out.map(o => o.kind), ['mention', 'digest']);
    assert.match(out[1].title, /1 条新消息/, '被提醒过的那条不该重复计数');
});

test('buildNotifications: 空输入返回空数组', () => {
    assert.deepStrictEqual(nr.buildNotifications([], ME, { notifyAll: true }), []);
    assert.deepStrictEqual(nr.buildNotifications(null, ME, {}), []);
});
test('buildNotifications: 签到机器人 @ 每个成员，不该产生通知', () => {
    const bot = msg(1, '粉丝群', '@登的厉害 连续签到可加速群聊等级升级哦，你今天还没签到，快去看看http://t.cn/x');
    assert.deepStrictEqual(nr.buildNotifications([bot], ME, {}), [],
        '实测这类消息占「提到我」命中的 93%（204/219），漏掉它通知就只剩广告');
});

test('buildNotifications: 红包等系统噪声也不通知，且不计入汇总', () => {
    const out = nr.buildNotifications(
        [msg(1, 'a', '恭喜张三领取了李四的红包'), msg(2, 'b', '正常发言')],
        ME, { notifyAll: true, group: 'G' }
    );
    assert.strictEqual(out.length, 1);
    assert.match(out[0].title, /1 条新消息/, '噪声不该被算进"N 条新消息"');
});

test('buildNotifications: 真人 @ 我（非签到文案）照常通知', () => {
    const out = nr.buildNotifications([msg(1, '张三', '@登的厉害 帮我看下这个 PR')], ME, {});
    assert.deepStrictEqual(out.map(o => o.kind), ['mention']);
});
