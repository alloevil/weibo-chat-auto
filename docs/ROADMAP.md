# Roadmap / 项目路线图

> Moved from issue #10 on 2026-09-04. Issues are for bug reports and feature requests; the roadmap lives here. To pick up an item, open an issue referencing it.

## 当前能力(v1.15+)

- **归档**:多群、增量、可断点续传;分页 API 拉全量历史;按天 JSON 落盘;定时任务 + 手动 Sync Now
- **桌面端**:Tauri v2 原生应用,应用内扫码登录,Bun sidecar 独立二进制;cookie 自动持久化 + 24h 滚动会话保活
- **查看器**:多主题、日历、全日期搜索、统计面板、上下文追溯面板、引用跳转、@提及高亮、桌面通知
- **实时**:可选的 Live 同步(默认关,关闭时保证零请求)+ 群内发消息(文本/表情/图片)
- **AI**:每日摘要 + Agentic 问答(多轮检索,基准测试见 README)

## Roadmap

- [x] **更多导出格式** — 目前只有按天 JSON;计划支持 Markdown / 自包含 HTML 导出,方便存档和分享(#11)
- [x] **Linux 定时任务自动安装** — 目前 `npm run archive` 的定时任务只在 macOS 上自动安装(launchd),Linux 用户需要手动配 cron;计划提供 systemd timer / cron 的一键安装(#12)
- [ ] **Windows 原生支持** — 目前 Windows 走 WSL;Tauri 本身跨平台,主要工作量在 Chrome 探测、路径处理和 sidecar 构建
- [ ] **图片发送端点验证** — `/webim/uploadx.json` 是从 webim 前端 bundle 逆向出来的,尚未对真实 API 验证(README 已如实标注);需要真实验证 + 失败时的清晰错误提示
- [ ] **多账号支持** — 目前单账号单 cookie;多账号需要 cookie 隔离和群归属区分

### 产品优化

产品评审(2026-08-21)提出的获客与留存改进——「下载 → 选群 → 每日回访」完整旅程:

- [x] 预构建 .app 下载作为第一安装路径 (#17)
- [x] 登录后应用内选群,替代手工编辑 config.json (#18)
- [x] 定时归档后自动生成当日 AI 摘要并推送桌面通知 (#19)

### 技术欠债

代码评审发现的结构性问题——不是新功能,但决定后续每个功能的改动成本:

- [x] /api/sync 并发防护:running 时 409 + 归档器跨进程 lockfile (#14)
- [x] rewriteImageUrls 停止污染消息缓存:序列化时改写副本,删除 originalPicUrl 逆变换 (#15)
- [x] 归档器分页状态机抽成 lib/paginate.js 加注入式测试,并消灭 USER_SCRIPT 的 normalizeMessage 漂移副本 (#16)

## 非目标

- 云端存储 / 任何形式的数据上传 — 所有数据永远留在本地
- 绕过微博风控的任何手段 — 保活机制只做正常的会话续期

带编号的项已建对应 issue;没编号的先在这里讨论。





