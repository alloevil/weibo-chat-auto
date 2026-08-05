# weibo-chat-auto 项目约定

微博群聊归档器 + 本地查看器 + Tauri 桌面壳。以下约定是历史事故换来的，改动前先读懂背后的"为什么"。

## 前端现状：零构建 vanilla 单文件

- 前端是 vanilla HTML/CSS/JS 单文件（viewer.html 三段式：`<style>` → HTML → 一个大 `<script>`），改完刷新即生效，无构建步骤。日常改动沿用现有 vanilla 模式即可；是否引入框架/构建由用户决定，不是既定禁区。
- 设计系统 = 手写 CSS 自定义属性 tokens（`--primary`、`--surface-*`、`--hairline`、`--danger`）。新 UI 复用 tokens，不引新色值。
- 全仓库 CommonJS（`"type": "commonjs"`），`.mjs` 仅限 qa-agent / eval / scripts 下的独立脚本。LSP 的"可转换为 ES module"提示是噪音，忽略。

## 目录职责

- `lib/` — 纯逻辑模块，**与 `test/` 1:1 对口**；单模块 <300 行
- `scripts/` — 辅助工具（索引构建、渲染冒烟、截图）；`eval/` — 评测（questions/run-eval/benchmark）
- 运行时数据（`output/ state/ cache/ logs/ cookies.json config.json ai-config.json`）全部 gitignore，不进版本库
- 入口脚本留在根目录（sidecar 打包、launchd plist、setup.sh 都引用现路径，不要收拢进 src/）

## 测试哲学

- 只用 `node:test` 原生 runner（`npm test`），**不引 vitest/jest/sinon**。mock 手法：每测试文件独立进程，直接补丁 `global.fetch` 或模块导出对象，`t.after` 恢复。
- 测试必须防住真实 bug：不变量、回归（用真实事故日志同构的输入）、契约。不测编排管道（`main()` CLI、真实 LLM 调用）——mock 出来只是复述管道。
- 难测的代码先把纯逻辑抽进 `lib/` 再测（day-file / sync-report / weibo-auth 都是这么来的），不要为覆盖率数字硬 mock。
- 提交前：`npm run lint && npm test`。改了 viewer.html 内联 JS 跑 `node scripts/render-smoke.js`（需本地归档数据）。

## 硬契约（背后都是真实事故）

- **登录判据只认 webim 接口 `error_code`**（21301=未鉴权，其它业务码=已鉴权），绝不猜 DOM/URL/标题——猜 DOM 曾让归档器带失效 Cookie 静默空跑 3 天。唯一实现在 `lib/weibo-auth.js`。
- **未登录时绝不吸收 Set-Cookie**：死会话下 weibo.com 派发游客 Cookie，吸收会污染 cookies.json。
- **归档器失败必须以非零退出码收场**（Cookie 失效、有群被跳过都算失败）；exit 0 = 全部群归档成功。viewer 的 `/api/sync` 靠这个契约解析结果（`lib/sync-report.js`，有单测）。
- **日文件写入只走 `lib/day-file.js`**：本地时区零填充、原子写、损坏备份 `.corrupt.<ts>`。
- 会话保活：weibo.com 的 24h 滚动会话（WBPSESS）靠 `weiboAuth.refreshSession()` 续期（viewer 每 30 分钟 + 归档器每轮跑完）。

## 构建与发布

- **改了 viewer-server.js / lib/ 后必须重建 sidecar**：`node sidecar/build.mjs`（run-desktop.sh 只在二进制缺失时才编译，旧包会一直被复用）。
- 版本发布：功能提交在前，独立 `Bump version to X.Y.Z` 提交同步 4 处（package.json、src-tauri/Cargo.toml、src-tauri/Cargo.lock 里 weibo-chat-viewer 条目、src-tauri/tauri.conf.json）。注意 sed 批量替换 Cargo.lock 会误伤同版本号的其它 crate。
- GitHub Release：中文标题（`vX.Y.Z — 一句话摘要`）+ `##` 分节中文 notes；建 release 自动打 tag → `release.yml` 构建 macOS .app 上传。
- 提交信息：英文祈使句标题 + root-cause 叙事正文，结尾 `Co-Authored-By: Claude <noreply@anthropic.com>`。
- viewer.html 在 `.prettierignore` 里；CI 会抽出它的内联 script 做 `node --check`。
