---
description: 改动 viewer-server.js 或 lib/ 后的 sidecar 重建与验证流程
condition: ["viewer-server.js", "lib/*.js"]
interruptMode: tool-only
---

# sidecar 重建提醒

你正在改 viewer-server.js 或 lib/ —— 这些代码会被 Bun 打进桌面应用的 sidecar 二进制：

1. 改完并通过 lint/test 后运行 `node sidecar/build.mjs` 重建 `src-tauri/binaries/viewer-server-*`。
2. `run-desktop.sh` 只在二进制缺失时才编译，不重建的话桌面 App 会一直跑旧代码。
3. 若本机有 detached 的 viewer 进程在跑（`hub ps` 查 `viewer`），重启它以加载新代码。
4. 服务端行为变化用 curl 冒烟：`/api/auth-status`、`/api/sync-progress`、页面 200。
