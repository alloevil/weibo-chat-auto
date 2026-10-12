export function candidateCases() {
    const message = (id, content, index, extra = {}) => ({
        id,
        content,
        user: '演示成员',
        timestamp: Date.parse('2026-01-01T00:00:00Z') + index * 3600000,
        time: `2026/01/01 ${String(index).padStart(2, '0')}:00:00`,
        ...extra,
    });
    const noise = Array.from({ length: 12 }, (_, index) =>
        message(`noise-${index}`, `数据库文档 修订事项 ${index}`, index + 1)
    );
    const common = { category: 'candidate-quality', args: { keywords: ['数据库文档'] } };
    return [
        {
            ...common,
            id: 'exact-domain-unique-noise',
            question: 'postgres.org 的文档是谁发的',
            messages: [
                message('exact', '文档链接', 0, { link: 'https://postgres.org/docs' }),
                ...noise,
            ],
            gold: ['exact'],
        },
        {
            ...common,
            id: 'exact-url-path',
            question: 'https://docs.example.org/setup.html 这个页面在哪里',
            messages: [message('exact', 'https://docs.example.org/setup.html', 0), ...noise],
            gold: ['exact'],
        },
        {
            ...common,
            id: 'exact-ticket',
            question: 'BUG-731 的详情',
            messages: [message('exact', 'BUG-731 原因说明', 0), ...noise],
            gold: ['exact'],
        },
        {
            ...common,
            id: 'exact-filename',
            question: 'release-notes.md 在哪里',
            messages: [message('exact', 'release-notes.md 已上传', 0), ...noise],
            gold: ['exact'],
        },
        {
            ...common,
            id: 'domain-prefix-not-promoted',
            question: 'postgres.org 的文档',
            messages: [
                message('near', 'postgres.org.evil 数据库文档', 0),
                message('exact', 'https://postgres.org/docs', 1),
                ...noise,
            ],
            gold: ['exact'],
            notExact: ['near'],
        },
        {
            ...common,
            id: 'ticket-prefix-not-promoted',
            question: 'BUG-73 的详情',
            messages: [
                message('near', 'BUG-731 数据库文档', 0),
                message('exact', 'BUG-73 正确事项', 1),
                ...noise,
            ],
            gold: ['exact'],
            notExact: ['near'],
        },
        {
            ...common,
            id: 'exact-outside-person',
            question: 'postgres.org 的文档',
            args: { keywords: ['数据库文档'], person: '小林' },
            messages: [
                message('excluded', 'postgres.org', 0, { user: '阿渡' }),
                ...noise.map((item) => ({ ...item, user: '小林' })),
            ],
            gold: ['noise-0'],
            forbidden: ['excluded'],
        },
        {
            id: 'repeat-different-people',
            category: 'candidate-quality',
            question: '部署确认是谁说的',
            args: { keywords: ['部署确认'] },
            messages: Array.from({ length: 4 }, (_, index) =>
                message(`speaker-${index}`, '部署确认完成', index, { user: `成员${index}` })
            ),
            gold: ['speaker-0', 'speaker-1', 'speaker-2', 'speaker-3'],
        },
    ];
}
