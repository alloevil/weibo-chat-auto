# Weibo Group Chat Archiver

自动抓取微博网页聊天群的历史消息，支持多群、定时运行、按天导出和本地可视化查看。

## 功能

**归档**
- 多群支持，通过 `config.json` 配置
- 自动登录（Cookie 保持）
- 通过 API 分页加载所有历史消息
- 增量归档，每次从上次截止时间继续
- 按日期分组导出为 JSON
- 定时任务（macOS launchd）+ 手动 Sync Now

**查看器**
- 多群切换
- 日历选择 + 自动刷新（60s 轮询）
- 时段热力图、用户筛选、媒体类型筛选
- 搜索（消息内容 + 用户名，高亮匹配）
- 消息统计面板（日活跃、用户排行、时段分布、词频）
- 红包/噪声消息过滤
- 图片代理（绕过防盗链）、视频链接
- 微博分享卡片、转发引用区块
- 用户头像、Emoji 渲染

## 安装

```bash
git clone https://github.com/alloevil/weibo-chat-auto.git
cd weibo-chat-auto
npm install
```

## 使用步骤

### 1. 首次使用：保存 Cookie

```bash
npm run save-cookies
```

会弹出一个**全新的浏览器窗口**（不是你日常用的 Chrome），打开微博聊天页面：

1. 用微博 App 扫描页面上的二维码
2. 手机确认登录
3. 浏览器跳转到聊天列表后，Cookie 自动保存到 `cookies.json`，窗口关闭

> **为什么用独立窗口？** 归档器通过 Puppeteer 启动独立浏览器，与你日常的 Chrome 隔离，不共享登录状态。所以必须单独扫码登录一次，把 Cookie 存到 `cookies.json`，归档器之后用它来访问微博。

### 2. 配置目标群聊

编辑 `config.json`，`groups` 数组填入群名称（必须与微博聊天中的群名完全一致）：

```json
{
    "chromePath": "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "groups": ["群名称A", "群名称B"]
}
```

### 3. 运行归档

```bash
npm run archive
```

首次运行会拉取最近 7 天的消息，之后每次增量更新。

### 4. 查看归档数据

```bash
npm run view
```

打开 http://localhost:3456 查看消息。页面右上角有 **Sync Now** 按钮可手动触发同步。

### 5. 定时自动运行（可选）

```bash
./setup.sh
```

或手动管理：

```bash
launchctl load ~/Library/LaunchAgents/com.allo.weibo-chat-archive.plist
launchctl list | grep weibo        # 查看状态
launchctl unload ~/Library/LaunchAgents/com.allo.weibo-chat-archive.plist  # 停用
```

## 日常使用

配置好之后，日常只需要这两步：

```bash
npm run view      # 启动查看器（一直开着即可）
```

打开 http://localhost:3456，点右上角 **Sync Now** 按钮即可同步最新消息。查看器会每 60 秒自动刷新数据。

### Cookie 维护

Cookie 有时效性（通常几天到两周）。**归档器每次成功运行后会自动刷新 Cookie**，所以：

- **保持定时任务运行** → Cookie 自动续期，永不过期（推荐）
- 或**每天点一次 Sync Now** → 手动保持 Cookie 活跃

只有当长时间没运行归档、Cookie 已过期时（同步报错、日历不更新），才需要重新扫码：

```bash
npm run save-cookies   # 重新扫码登录
```

> 重新扫码不影响已归档的数据，只是刷新登录凭据。

## 项目结构

```
├── config.json              # 群聊配置 + Chrome 路径
├── auto-archive-simple.js   # 主归档脚本
├── save-cookies.js          # Cookie 保存工具
├── viewer-server.js         # 本地查看器服务器
├── viewer.html              # 查看器页面（单页应用）
├── cookies.json             # 登录凭据（不提交）
├── state/                   # 归档状态文件（不提交）
├── output/                  # 归档数据（不提交）
│   └── 群名/
│       ├── weibo_chat_2026-05-01.json
│       └── ...
├── cache/images/            # 图片缓存（不提交）
├── com.allo.weibo-chat-archive.plist  # macOS 定时任务配置
└── package.json
```

## 输出数据格式

每条消息包含：

```json
{
    "id": 123456789,
    "from_uid": 12345,
    "user": "用户名",
    "avatar": "https://...",
    "timestamp": 1778000000000,
    "time": "2026/05/11 12:00:00",
    "date": "2026-05-11",
    "content": "消息内容",
    "type": 321,
    "pics": ["https://upload.api.weibo.com/2/mss/msget?source=209678993&fid=..."],
    "share": {
        "url": "http://weibo.com/...",
        "title": "...",
        "author": "...",
        "pics": ["https://wx1.sinaimg.cn/large/..."],
        "reposts": 100,
        "comments": 50,
        "likes": 200
    }
}
```

## 故障排除

### Cookie 失效

Cookie 有时效性，过期后归档器无法登录微博。表现为归档日志中出现"未找到群聊"或"扫描登录"。

**解决方法：**

```bash
npm run save-cookies
```

浏览器会打开微博聊天页面。扫码登录后 Cookie 自动保存。

**为什么 Cookie 会过期？**

归档器通过 Puppeteer 启动独立的 Chrome 实例，不共享你日常浏览器的登录状态。微博的 Cookie 有时效性（通常几天到两周）。如果长时间没有运行归档（例如定时任务被停用），Cookie 会过期。

**保持 Cookie 活跃的方法：**

- 保持定时任务运行 — 归档器每次成功运行后会自动刷新 Cookie
- 或每天在 viewer 页面点一次 **Sync Now** 按钮
- Cookie 过期后运行 `npm run save-cookies` 重新登录即可

### 页面加载失败

检查 `config.json` 中的 `chromePath` 是否正确，确保已安装 Google Chrome

### 图片不显示

图片通过本地服务器代理加载（需要有效的 Cookie），Cookie 过期后图片无法显示

## 隐私声明

**本工具仅供归档自己参与的群聊消息，请勿用于侵犯他人隐私。**

- 归档的数据包含群内所有成员的消息内容、用户名和头像
- 请妥善保管 `cookies.json` 和 `output/` 目录，不要公开分享
- 本项目代码仅供学习交流，使用者需自行承担风险
- 请遵守微博服务条款和相关法律法规

## License

MIT
