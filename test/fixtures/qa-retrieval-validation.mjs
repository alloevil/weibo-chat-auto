const origin = Date.parse('2026-02-01T00:00:00Z');

function record(id, content, minutes = 0, user = '林青禾', extra = {}) {
    const timestamp = origin + minutes * 60000;
    const date = new Date(timestamp).toISOString();
    return {
        id,
        content,
        user,
        timestamp,
        date: date.slice(0, 10),
        time: date.slice(0, 19).replace('T', ' ').replaceAll('-', '/'),
        ...extra,
    };
}

function distractors(topic, count = 12, start = 40 * 1440) {
    return Array.from({ length: count }, (_, index) =>
        record(
            `noise-${index}`,
            `${topic} 有空再看看，还没有新的信息。`,
            start + index * 60,
            '小林'
        )
    );
}

export function retrievalValidationCases() {
    const cases = [
        {
            id: 'decision-rollback',
            category: 'historical',
            question: '当时为什么放弃 Redis 缓存？',
            args: { keywords: ['Redis', '缓存'] },
            messages: [
                record(
                    'decision',
                    'Redis 缓存方案已否决：一致性维护成本超过收益，保留数据库直查。'
                ),
                ...distractors('Redis 缓存'),
            ],
            gold: ['decision'],
        },
        {
            id: 'latest-rollback',
            category: 'recency',
            question: 'Redis 缓存方案最新进展是什么？',
            args: { keywords: ['Redis', '缓存'] },
            messages: [
                record('decision', 'Redis 缓存最初被否决。'),
                ...distractors('Redis 缓存'),
                record(
                    'updated',
                    'Redis 缓存最新结论：小流量试点通过，先给搜索服务启用。',
                    45 * 1440
                ),
            ],
            gold: ['updated'],
        },
        {
            id: 'explicit-month',
            category: 'date-filter',
            question: '最近提到的那次事故，二月一日给出的原因是什么？',
            args: { keywords: ['事故'], dateFrom: '2026-02-01', dateTo: '2026-02-01' },
            messages: [
                record('incident', '事故原因是索引发布时错误删除了旧版本。'),
                record('later', '事故原因仍在整理。', 40 * 1440),
            ],
            gold: ['incident'],
        },
        {
            id: 'person-only',
            category: 'person-filter',
            question: '阿渡对部署窗口说了什么？',
            args: { keywords: ['部署'], person: '阿渡' },
            messages: [
                record('person', '部署窗口定为晚上十点，不要影响白天访问。', 0, '阿渡'),
                record('other', '部署窗口上午九点。', 80, '小林'),
            ],
            gold: ['person'],
            forbidden: ['other'],
        },
        {
            id: 'identifier-original',
            category: 'original-query',
            question: 'BUG-731 的根因是什么？',
            args: { keywords: ['线上故障'] },
            messages: [
                record('ticket', 'BUG-731 根因：时区转换造成日期边界错误。'),
                ...distractors('线上故障'),
            ],
            gold: ['ticket'],
        },
        {
            id: 'url-original',
            category: 'original-query',
            question: '谁分享过 postgres.org 的文档？',
            args: { keywords: ['数据库文档'] },
            messages: [
                record('url', '这篇比较清楚。', 0, '半夏', {
                    share: { title: 'PostgreSQL manual', url: 'https://postgres.org/docs/' },
                }),
                ...distractors('数据库文档'),
            ],
            gold: ['url'],
        },
        {
            id: 'case-sensitive-id',
            category: 'identifier',
            question: 'HTTP_429 怎么处理？',
            args: { keywords: ['http_429'] },
            messages: [
                record('id', 'HTTP_429 要读取 Retry-After，不能立即重试。'),
                record('unrelated', '今天午饭吃面。', 90),
            ],
            gold: ['id'],
        },
        {
            id: 'picture-fields',
            category: 'media',
            question: '半夏发过哪些图片？',
            args: { keywords: ['图片'], person: '半夏' },
            messages: [
                record('picture', '', 0, '半夏', { pics: ['https://example.invalid/chart.png'] }),
                record('chat', '准备开会。', 90),
            ],
            gold: ['picture'],
        },
        {
            id: 'english-evidence',
            category: 'english',
            question: 'Why was the blue deployment rejected?',
            args: { keywords: ['deployment', 'rejected'] },
            messages: [
                record(
                    'english',
                    'The blue deployment was rejected because rollback was not supported.'
                ),
                ...distractors('deployment release'),
            ],
            gold: ['english'],
        },
        {
            id: 'chinese-no-evidence',
            category: 'no-evidence',
            question: '请问群里有没有讨论过火星样本运输？',
            args: { keywords: ['火星样本运输'] },
            messages: [
                record('chat-a', '请问群里有没有人吃过这家面馆？'),
                record('chat-b', '之前讨论过耳机的降噪。', 90),
            ],
            gold: [],
        },
        {
            id: 'english-no-evidence',
            category: 'no-evidence',
            question: 'Does anyone know about quantum teleportation?',
            args: { keywords: ['quantum teleportation'] },
            messages: [
                record('chat-a', 'Does anyone know about the lunch menu?'),
                record('chat-b', 'Can we book a meeting room?', 90),
            ],
            gold: [],
        },
        {
            id: 'unknown-person',
            category: 'person-fallback',
            question: '阿林提过数据库迁移吗？',
            args: { keywords: ['数据库迁移'], person: '阿林' },
            messages: [
                record('fallback', '数据库迁移之前要先备份。', 0, '林青禾'),
                record('other', '今天开会。', 90),
            ],
            gold: ['fallback'],
        },
        {
            id: 'known-semantic-gap',
            category: 'semantic-gap',
            question: '投资仓位调整的建议是什么？',
            args: { keywords: ['投资', '仓位'] },
            messages: [
                record('semantic', '把芯片股清了一半，落袋为安。'),
                record('food', '晚饭吃饺子。', 90),
            ],
            gold: ['semantic'],
        },
        {
            id: 'contradicting-updates',
            category: 'multiple-evidence',
            question: '发布计划是怎么从周五改成周一的？',
            args: { keywords: ['发布计划'] },
            messages: [
                record('initial', '发布计划：先约周五下午。'),
                ...distractors('发布计划'),
                record(
                    'revised',
                    '发布计划调整为周一，周五测试没过，不要按原约定上线。',
                    44 * 1440
                ),
            ],
            gold: ['initial', 'revised'],
        },
    ];
    const thread = Array.from({ length: 49 }, (_, index) =>
        record(`thread-${index}`, `日常交接事项 ${index}`, index, index % 2 ? '半夏' : '阿渡')
    );
    thread[5].content = '星河迁移第一步：先双写三天。';
    thread[39].content = '星河迁移最后一步：验证一致后关闭旧写入。';
    cases.push({
        id: 'separated-steps',
        category: 'multiple-evidence',
        question: '星河迁移先后要做什么？',
        args: { keywords: ['星河迁移'] },
        messages: [...thread, record('other-thread', '办公室搬家。', 100)],
        gold: ['thread-5', 'thread-39'],
    });
    const blocks = Array.from({ length: 5 }, (_, block) =>
        Array.from({ length: 26 }, (_, index) =>
            record(
                `block-${block}-${index}`,
                index === 22
                    ? `证书轮换：服务${block}必须保留旧证书，回滚窗口七天。`
                    : `值班记录 ${index}`,
                block * 120 + index
            )
        )
    ).flat();
    cases.push({
        id: 'late-rerank-evidence',
        category: 'preview',
        question: '证书轮换怎么回滚？',
        args: { keywords: ['证书轮换', '回滚'] },
        messages: blocks,
        gold: ['block-0-22'],
        previewNeedles: ['旧证书'],
    });
    const longRecord = record(
        'long-record',
        '发布相关背景资料。'.repeat(50) + '预算上限为八万元，超出必须审批。',
        0,
        '阿渡'
    );
    cases.push({
        id: 'long-text-keyword-tail',
        category: 'preview',
        question: '阿渡说的预算上限是多少？',
        args: { keywords: ['预算上限'], person: '阿渡' },
        messages: [
            longRecord,
            ...Array.from({ length: 5 }, (_, index) =>
                record(`budget-${index}`, '预算上限以后再确认。', 100 + index * 90, '阿渡')
            ),
        ],
        gold: ['long-record'],
        previewNeedles: ['八万元'],
    });
    cases.push({
        id: 'no-messages',
        category: 'empty',
        question: '发布进展？',
        args: { keywords: ['发布'] },
        messages: [],
        gold: [],
    });
    return cases;
}
