export function retrievalCases() {
    const cases = [];
    const base = Date.parse('2026-01-01T00:00:00Z');
    const message = (id, content, minutes, user = '成员甲') => {
        const timestamp = base + minutes * 60000;
        const iso = new Date(timestamp).toISOString();
        return {
            id,
            user,
            content,
            timestamp,
            date: iso.slice(0, 10),
            time: iso.slice(0, 19).replace('T', ' ').replaceAll('-', '/'),
        };
    };
    for (let variant = 0; variant < 10; variant++) {
        const key = `releasecode${variant}`;
        const recent = Array.from({ length: 12 }, (_, index) =>
            message(`recent-${index}`, `${key} 随便讨论的一个点`, 40 * 1440 + index * 60)
        );
        const old = message(
            'original-decision',
            `${key} ${key} ${key} 原始决定与否决原因已记录`,
            0
        );
        cases.push({
            id: `history-${variant}`,
            category: 'historical',
            question: `${key} 当时为什么被否决`,
            args: { keywords: [key] },
            messages: [old, ...recent],
            gold: [old.id],
        });
        cases.push({
            id: `latest-${variant}`,
            category: 'latest-control',
            question: `${key} 最新讨论`,
            args: { keywords: [key] },
            messages: [old, ...recent],
            gold: [recent.at(-1).id],
        });
        cases.push({
            id: `original-${variant}`,
            category: 'original-query',
            question: `uniqueissue${variant}`,
            args: { keywords: [`expandedterm${variant}`] },
            messages: [
                message('original-query-match', `uniqueissue${variant} 已解决`, 0),
                ...Array.from({ length: 10 }, (_, index) =>
                    message(`expanded-${index}`, `expandedterm${variant} 不同事件`, 60 + index * 60)
                ),
            ],
            gold: ['original-query-match'],
        });
        const long = Array.from({ length: 48 }, (_, index) =>
            message(`long-${index}`, `常规记录序号 ${index}`, index)
        );
        long[8].content = `anchorleft${variant} 的原始建议`;
        long[38].content = `anchorright${variant} 的最终决定`;
        cases.push({
            id: `multi-${variant}`,
            category: 'multiple-evidence',
            question: `anchorleft${variant} anchorright${variant}`,
            args: { keywords: [`anchorleft${variant}`, `anchorright${variant}`] },
            messages: [...long, message('unrelated-block', '另一个完全无关话题', 120)],
            gold: ['long-8', 'long-38'],
        });
        const late = Array.from({ length: 24 }, (_, index) =>
            message(
                `late-${index}`,
                index === 20 ? `protocolid${variant} 使用约定端口` : `普通问候记录 ${index}`,
                index
            )
        );
        cases.push({
            id: `late-${variant}`,
            category: 'late-hit-control',
            question: `protocolid${variant}`,
            args: { keywords: [`protocolid${variant}`] },
            messages: [...late, message('next-block', '周末散步路线', 100)],
            gold: ['late-20'],
        });
        cases.push({
            id: `none-${variant}`,
            category: 'no-evidence',
            question: `unknownidentifier${variant}`,
            args: { keywords: [`unknownidentifier${variant}`] },
            messages: [
                message('other-1', '早先讨论部署', 0),
                message('other-2', '后来讨论天气', 100),
            ],
            gold: [],
        });
    }
    return cases;
}
