# weibo-chat-auto — Agent 指南

微博群聊归档器（puppeteer）+ 本地查看器（node:http + vanilla 前端）+ Tauri 桌面壳。纯 Node ≥18 + CommonJS，无 TypeScript、无前端框架、无构建步骤。以下约定多数是历史事故换来的，改动前先读懂"为什么"。

## 常用命令

| 任务 | 命令 |
| --- | --- |
| 全部测试 | `npm test`（node:test，<2s） |
| 单文件测试 | `node --test test/day-file.test.js` |
| 覆盖率 | `node --test --experimental-test-coverage --test-coverage-exclude='test/**'` |
| Lint / 格式化 | `npm run lint` / `npm run format`（format:check 不在 CI，别依赖它拦人） |
| 启动查看器 | `npm run view`（http://127.0.0.1:3456） |
| 手动归档 | `npm run archive`（真实抓取，跑数分钟，勿当冒烟测试用） |
| 重新扫码 | `npm run save-cookies` |
| 渲染冒烟 | `node scripts/render-smoke.js`（需本地归档数据；改 viewer.html 后必跑） |
| 重建 sidecar | `node sidecar/build.mjs`（改 viewer-server.js / lib/ 后必跑，见下） |

## 环境变量

- `HEADLESS=0` — 归档器开真实 Chrome 窗口（调试扫码/选择器用）
- `NO_OPEN=1` — 查看器启动时不自动开浏览器
- `WEIBO_PORT` / `WEIBO_OUTPUT_DIR` — 查看器端口（默认 3456）与数据目录
- `config.json` 的 `chromePath` — Chrome 路径覆盖（缺省走 lib/chrome-path 探测）

## 安全与隐私（本仓库最重要的边界）

- `cookies.json` 是微博登录凭据；`output/`、`cache/` 是**私人聊天记录**。三者已 gitignore——绝不能进提交、日志、issue、release notes 或任何公开产物。需要截图用 `node scripts/take-screenshot.js`（自带内容打码）。
- 查看器 API 无鉴权，**只允许监听 127.0.0.1**（绑 0.0.0.0 = 向局域网泄露全部聊天记录，修过一次）。
- 会拼进文件路径的请求参数必须先校验格式（date 参数曾有 `../` 穿越漏洞，读写 output/ 之外任意文件）。

## 边界

- **不要动**：`src-tauri/gen/**`（生成物）、`design-md/`（第三方参考材料）、`output/`/`state/` 里的数据文件、`temp-chrome/` 之类的本地运行残留。
- **先问再做**：新增运行时依赖、改 `.github/workflows/`、force push、删除或重写归档数据。

## 前端现状：零构建 vanilla 单文件

- viewer.html 三段式（`<style>` → HTML → 一个大 `<script>`），改完刷新即生效，无构建。日常改动沿用现有 vanilla 模式；是否引入框架/构建由用户决定，不是既定禁区。
- 设计系统 = CSS 自定义属性 tokens（`--primary`、`--surface-*`、`--hairline`、`--danger`）。新 UI 复用 tokens，不引新色值。
- viewer.html 在 `.prettierignore` 里；CI 会抽出内联 script 做 `node --check`，语法错会红。
- 全仓库 CommonJS，`.mjs` 仅限 qa-agent / eval / scripts 下的独立脚本。LSP 的"可转换为 ES module"提示是噪音，忽略。

## 目录职责

- `lib/` — 纯逻辑模块，**与 `test/` 1:1 对口**；单模块 <300 行
- `scripts/` — 辅助工具；`eval/` — 评测（questions / run-eval / benchmark-qa）
- 入口脚本留在根目录（sidecar 打包、launchd plist、setup.sh 都引用现路径，不要收拢进 src/）
- `foodmap/` 是共库的独立小应用（依赖 `../lib`），不拆库

## 测试哲学

- 只用 `node:test` 原生 runner，不引 vitest/jest/sinon。mock 手法：每测试文件独立进程，直接补丁 `global.fetch` 或模块导出对象，`t.after` 恢复。
- 测试必须防真实 bug：不变量、回归（输入用真实事故日志同构的串）、契约。不测 `main()` CLI 编排和真实 LLM 调用——mock 出来只是复述管道。
- 难测的代码先把纯逻辑抽进 `lib/` 再测（day-file / sync-report / weibo-auth 皆此来历），不为覆盖率数字硬 mock。

## 硬契约（背后都是真实事故）

- **登录判据只认 webim 接口 `error_code`**（21301=未鉴权，其它业务码=已鉴权），绝不猜 DOM/URL/标题——猜 DOM 曾让归档器带失效 Cookie 静默空跑 3 天。唯一实现在 `lib/weibo-auth.js`。
- **未登录时绝不吸收 Set-Cookie**：死会话下 weibo.com 派发游客 Cookie，吸收会污染 cookies.json。
- **归档器失败必须以非零退出码收场**（Cookie 失效、有群被跳过都算失败）；exit 0 = 全部群归档成功。`/api/sync` 依赖此契约解析结果（`lib/sync-report.js`，有单测；改归档器输出格式要同步改它和测试）。
- **日文件写入只走 `lib/day-file.js`**：本地时区零填充、原子写、损坏备份 `.corrupt.<ts>`。
- 会话保活：weibo.com 的 24h 滚动会话（WBPSESS）靠 `weiboAuth.refreshSession()` 续期（viewer 每 30 分钟 + 归档器每轮跑完）。

## 构建与发布

- **改 viewer-server.js / lib/ 后必须 `node sidecar/build.mjs`**：run-desktop.sh 只在二进制缺失时才编译，不重建则桌面 App 一直跑旧代码。本机若有 detached viewer 进程也要重启。
- 版本发布：功能提交在前，独立 `Bump version to X.Y.Z` 提交同步 4 处（package.json、src-tauri/Cargo.toml、src-tauri/Cargo.lock 的 weibo-chat-viewer 条目、src-tauri/tauri.conf.json）。sed 批量替换 Cargo.lock 会误伤同版本号的其它 crate，改指定条目。
- GitHub Release：中文标题（`vX.Y.Z — 一句话摘要`）+ `##` 分节中文 notes；建 release 自动打 tag → `release.yml` 构建 macOS .app 上传。
- 提交信息：英文祈使句标题 + root-cause 叙事正文，结尾 `Co-Authored-By: Claude <noreply@anthropic.com>`。分支命名沿用 `fix/<topic>`、`refactor/<topic>`。
