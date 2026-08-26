const { test } = require('node:test');
const assert = require('node:assert');
const { parseGroupSessions, normalizeSession, diffConfiguredGroups, fetchGroupSessions } = require('../lib/group-sessions.js');

test('normalizeSession: 内嵌 group 形态（形态 A）', () => {
    const g = normalizeSession({ type: 'group', group: { id: 123, name: '茧房建筑师协会', avatar: 'http://a/x.jpg', member_count: 42 } });
    assert.deepStrictEqual(g, { id: '123', name: '茧房建筑师协会', avatar: 'http://a/x.jpg', memberCount: 42 });
});

test('normalizeSession: 平铺形态（形态 B）与残缺条目', () => {
    const g = normalizeSession({ type: 'group', id: 9, name: '群B', profile_image_url: 'http://a/b.jpg' });
    assert.strictEqual(g.id, '9');
    assert.strictEqual(g.avatar, 'http://a/b.jpg');
    assert.strictEqual(g.memberCount, null);
    // 非群、无 id、id=0、无名 → null
    assert.strictEqual(normalizeSession({ type: 'private', id: 1, name: '私聊' }), null);
    assert.strictEqual(normalizeSession({ type: 'group', name: '无id' }), null);
    assert.strictEqual(normalizeSession({ type: 'group', id: 0, name: '零id' }), null);
    assert.strictEqual(normalizeSession({ type: 'group', id: 5 }), null);
    assert.strictEqual(normalizeSession(null), null);
});

test('parseGroupSessions: sessions/data.sessions/data 三种包裹形态,同名去重保序', () => {
    const sessions = [
        { type: 'group', group: { id: 1, name: '群A' } },
        { type: 'group', group: { id: 2, name: '群B' } },
        { type: 'group', group: { id: 3, name: '群A' } },   // 同名去重
        { type: 'private', id: 4, name: '某人' },            // 非群过滤
    ];
    for (const json of [{ sessions }, { data: { sessions } }, { data: sessions }]) {
        const r = parseGroupSessions(json);
        assert.deepStrictEqual(r.map(g => g.name), ['群A', '群B']);
        assert.strictEqual(r[0].id, '1');
    }
    assert.deepStrictEqual(parseGroupSessions({}), []);
    assert.deepStrictEqual(parseGroupSessions(null), []);
});

test('fetchGroupSessions: 21301 → unauthenticated 错误体', async () => {
    const r = await fetchGroupSessions({
        cookieHeader: 'dead',
        fetchImpl: async () => ({ json: async () => ({ error_code: 21301, error: 'auth' }) }),
    });
    assert.strictEqual(r.ok, false);
    assert.strictEqual(r.unauthenticated, true);
    assert.match(r.error, /扫码/);
});

test('fetchGroupSessions: 其它错误码与网络失败 → ok:false 且信息可读', async () => {
    const r1 = await fetchGroupSessions({
        fetchImpl: async () => ({ json: async () => ({ error_code: 21201, error: 'not exist' }) }),
    });
    assert.strictEqual(r1.ok, false);
    assert.match(r1.error, /21201/);
    const r2 = await fetchGroupSessions({ fetchImpl: async () => { throw new Error('ETIMEDOUT'); } });
    assert.strictEqual(r2.ok, false);
    assert.match(r2.error, /ETIMEDOUT/);
});

test('fetchGroupSessions: 响应正常但解析不出群 → 明确指向手编 config.json 的老路', async () => {
    const r = await fetchGroupSessions({
        fetchImpl: async () => ({ json: async () => ({ sessions: [{ type: 'private', id: 1, name: '某人' }] }) }),
    });
    assert.strictEqual(r.ok, false);
    assert.match(r.error, /config\.json/);
});

test('fetchGroupSessions: 正常路径返回群列表', async () => {
    const r = await fetchGroupSessions({
        fetchImpl: async () => ({ json: async () => ({ sessions: [{ type: 'group', group: { id: 7, name: '群X', avatar: 'http://a' } }] }) }),
    });
    assert.strictEqual(r.ok, true);
    assert.deepStrictEqual(r.groups.map(g => g.name), ['群X']);
});

test('diffConfiguredGroups: 配置群名与会话列表比对出 matched/missing', () => {
    const sessions = [{ name: '群A' }, { name: '群B' }];
    const { matched, missing } = diffConfiguredGroups(['群A', '打错的群名😀'], sessions);
    assert.deepStrictEqual(matched, ['群A']);
    assert.deepStrictEqual(missing, ['打错的群名😀']);
    assert.deepStrictEqual(diffConfiguredGroups([], sessions), { matched: [], missing: [] });
    assert.deepStrictEqual(diffConfiguredGroups(null, null), { matched: [], missing: [] });
});
// ── 真实接口形态（contacts.json）──────────────────────────────────────
// 这些串与线上响应同构：群与单聊都挂在 user 下，唯一区别是群有 type===2。
// 曾经打的是 /webim/query_sessions.json —— 那个路径不存在，恒回
// 20099「is not allow to access」，选群面板永远空着。

const realGroup = (id, name, groupType = 1, memberCount = 0) => ({
    unread_count: 0,
    message: { text: 'x' },
    user: {
        id, name, type: 2, group_type: groupType, member_count: memberCount,
        profile_image_url: `http://a/${id}.jpg`, avatar_large: `http://a/${id}_big.jpg`,
        members: [], admins: [], max_member_count: 500,
    },
});
const realDm = (id, screenName) => ({
    unread_count: 1,
    message: { text: 'y' },
    user: { id, screen_name: screenName, profile_image_url: `http://a/${id}.jpg`, verified_type: 0 },
});

test('parseGroupSessions: contacts 形态只挑出群，单聊一个都不许混入', () => {
    const json = {
        totalNumber: 173,
        contacts: [
            realGroup(4761715839862414, '茧房建筑师协会', 3),
            realDm(7892270010, '微博智搜'),
            realGroup(5110127851995592, '猫咪AI研究', 1),
            realDm(2015108055, '中央气象台'),
            realGroup(5152823595766382, '赛博动物园w', 2),
        ],
    };
    const r = parseGroupSessions(json);
    assert.deepStrictEqual(r.map(g => g.name), ['茧房建筑师协会', '猫咪AI研究', '赛博动物园w'],
        '单聊混进选群面板 = 用户勾了之后归档器永远找不到那个群');
    assert.strictEqual(r[0].id, '4761715839862414', '会话 id 必须原样保留（与 state.groupId 同源）');
    assert.strictEqual(r[1].avatar, 'http://a/5110127851995592.jpg');
});

test('normalizeSession: user.type 非 2 一律不是群，哪怕带了头像等群同名字段', () => {
    assert.strictEqual(normalizeSession(realDm(123, '某人')), null);
    assert.strictEqual(normalizeSession({ user: { id: 1, name: '伪群', type: 0, member_count: 9 } }), null);
    assert.ok(normalizeSession(realGroup(7, '真群')), '带 type=2 的才算群');
});

test('normalizeSession: 群 member_count 为 0 时保留 0，不塌成 null', () => {
    // 实测 contacts.json 里活跃群的 member_count 就是 0，别用真值判断
    assert.strictEqual(normalizeSession(realGroup(8, '零成员群', 1, 0)).memberCount, 0);
});

test('SESSIONS_PATH: 必须是 bundle 里真实存在的 contacts 接口', () => {
    const { SESSIONS_PATH } = require('../lib/group-sessions.js');
    assert.match(SESSIONS_PATH, /^\/webim\/2\/direct_messages\/contacts\.json\?/);
    assert.match(SESSIONS_PATH, /special_source=3/, '缺这个参数拿不到会话列表');
    assert.doesNotMatch(SESSIONS_PATH, /query_sessions/, '该路径不存在，恒回 20099');
});
