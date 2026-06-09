# 贡献指南

感谢你对本项目的兴趣！本文档说明如何参与开发。

## 开发环境

- macOS（定时任务依赖 launchd）
- Node.js 18+
- Google Chrome

```bash
git clone https://github.com/alloevil/weibo-chat-auto.git
cd weibo-chat-auto
npm install
```

## 项目结构

| 文件 | 作用 |
| --- | --- |
| `auto-archive-simple.js` | 归档器：登录、分页拉取、按天导出 |
| `save-cookies.js` | 扫码登录并保存 Cookie |
| `viewer-server.js` | 本地查看器服务器（图片代理、API、触发同步） |
| `viewer.html` | 查看器单页应用（HTML + CSS + JS 同文件） |
| `setup.sh` | 一键安装脚本 |

## 本地运行

```bash
npm run save-cookies   # 首次：扫码登录
npm run archive        # 归档一次
npm run view           # 启动查看器 → http://localhost:3456
```

查看器改动后，浏览器普通刷新即可生效（服务端已设 no-cache）。

## 提交规范

- 提交信息用英文祈使句，简明说明「做了什么」，必要时正文补充「为什么」
  - 例：`Add context-focus panel`、`Fix quote author resolution under filters`
- 一个 PR 聚焦一件事，避免混杂无关改动
- 提交前确保：
  - `node --check <改动的.js>` 通过
  - 若改了 `viewer.html`，本地实际刷新确认功能正常

## ⚠️ 隐私红线

本项目处理真实聊天数据，**切勿提交以下内容**（已在 `.gitignore` 中）：

- `cookies.json` — 登录凭据
- `output/` — 归档的聊天数据
- `config.json` — 含真实群名
- 任何含真实用户名/群名/头像的截图

如需提供截图，请先脱敏（假名 + 模糊头像 + 示例文本）。

## 提 Issue

- Bug：用 Bug 模板，附环境信息和日志（注意去除隐私）
- 功能建议：用功能建议模板，先说清要解决的痛点

## License

提交即表示你同意你的贡献以 [MIT License](LICENSE) 授权。
