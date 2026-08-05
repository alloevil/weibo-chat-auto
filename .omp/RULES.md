# 硬性规则

- 测试只用 node:test 原生 runner，不引入 vitest/jest/sinon。
- 本仓库提交必须用仓库 local git 身份（alloevil）；绝不让全局 gitconfig 的工作身份进入提交或推送。
- 归档器任何失败路径必须以非零退出码收场；登录态判断只认 webim error_code（lib/weibo-auth.js），不猜 DOM。
