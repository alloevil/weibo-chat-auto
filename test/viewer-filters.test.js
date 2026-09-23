const { test } = require('node:test');
const assert = require('node:assert');
const { filterViewerMessages } = require('../lib/viewer-filters');

const messages = [
    {
        id: 'text',
        date: '2026-09-22',
        timestamp: new Date('2026-09-22T09:00:00').getTime(),
        user: '甲',
        content: '你好',
    },
    {
        id: 'pic',
        date: '2026-09-22',
        timestamp: new Date('2026-09-22T10:00:00').getTime(),
        user: '乙',
        content: '',
        pics: ['x'],
    },
    {
        id: 'video',
        date: '2026-09-22',
        timestamp: new Date('2026-09-22T11:00:00').getTime(),
        user: '甲',
        content: 'Video',
    },
    {
        id: 'noise',
        date: '2026-09-22',
        timestamp: new Date('2026-09-22T12:00:00').getTime(),
        user: '机器人',
        content: '@我 签到',
    },
    {
        id: 'other-day',
        date: '2026-09-21',
        timestamp: new Date('2026-09-21T09:00:00').getTime(),
        user: '甲',
        content: '昨天',
    },
];

function filter(options = {}) {
    return filterViewerMessages(messages, {
        date: '2026-09-22',
        isNoise: (message) => message.id === 'noise',
        mentionsMe: (message) => message.content.includes('@我'),
        ...options,
    }).map((message) => message.id);
}

test('filterViewerMessages: 日期、小时与成员筛选可组合', () => {
    assert.deepStrictEqual(filter({ hours: new Set([9, 11]), users: new Set(['甲']) }), [
        'text',
        'video',
    ]);
});

test('filterViewerMessages: 图片、视频与链接类型判定', () => {
    assert.deepStrictEqual(filter({ mediaFilter: 'pics' }), ['pic']);
    assert.deepStrictEqual(filter({ mediaFilter: 'video' }), ['video']);
    assert.deepStrictEqual(
        filterViewerMessages([{ ...messages[0], link: 'https://example.test' }], {
            date: '2026-09-22',
            mediaFilter: 'link',
        }).map((message) => message.id),
        ['text']
    );
});

test('filterViewerMessages: @我 无条件排除噪声', () => {
    assert.deepStrictEqual(filter({ mentionOnly: true, hideNoise: false }), []);
    assert.deepStrictEqual(filter({ hideNoise: true }), ['text', 'pic', 'video']);
});
