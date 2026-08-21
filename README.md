<p align="center">
  <img src="./assets/hero.svg" width="100%" alt="Weibo Group Chat Archiver — automatically archive Weibo group chat messages, native desktop app + AI summaries and Q&A">
</p>

<p align="center">
  <img alt="Tauri" src="https://img.shields.io/badge/Tauri-2-FFC131?logo=tauri&logoColor=white">
  <img alt="Node" src="https://img.shields.io/badge/Node-%E2%89%A518-339933?logo=node.js&logoColor=white">
  <img alt="Puppeteer" src="https://img.shields.io/badge/Puppeteer-24-40B5A4?logo=puppeteer&logoColor=white">
  <a href="https://github.com/alloevil/weibo-chat-auto/actions/workflows/ci.yml"><img alt="CI" src="https://img.shields.io/github/actions/workflow/status/alloevil/weibo-chat-auto/ci.yml?logo=githubactions&logoColor=white&label=CI"></a>
  <a href="https://github.com/alloevil/weibo-chat-auto/releases/latest"><img alt="Release" src="https://img.shields.io/github/v/release/alloevil/weibo-chat-auto?logo=github&color=blue"></a>
  <img alt="Platform" src="https://img.shields.io/badge/Platform-macOS%20%7C%20Linux%20%7C%20WSL-555">
  <img alt="License" src="https://img.shields.io/badge/License-MIT-blue">
  <img alt="Stars" src="https://img.shields.io/github/stars/alloevil/weibo-chat-auto?style=flat&logo=github&color=yellow">
</p>

<p align="center">
  English | <a href="README.zh-CN.md">简体中文</a>
</p>

<p align="center">
  <a href="#-quick-start">Quick Start</a> ·
  <a href="#-features">Features</a> ·
  <a href="#-ai-features">AI Features</a> ·
  <a href="#-screenshots">Screenshots</a>
</p>

---

Automatically archive message history from Weibo web group chats — as a **native desktop app** (in-app QR-code login, no manual cookie setup) or a local viewer. Supports multiple groups, scheduled archiving, per-day JSON export, and comes with AI daily summaries and agentic Q&A built in.

---

## 🎬 Demo

![Demo](docs/demo.gif)

> Usernames, group names, and avatars in the demo are anonymized samples.

---

## ✨ Features

| Archiver | Viewer |
| --- | --- |
| 🗂 Multi-group support (configured in `config.json`) | ⚡ Live sync (opt-in, off by default): new messages appear automatically |
| 🖥 Native desktop app (in-app QR-code login) | 💬 **Send messages to the group**: text / emoticons / images |
| 🍪 Automatic cookie persistence + session keep-alive | 🎨 Switchable themes: Linear dark / QQ 2000 / 2008 / 2012 |
| 📡 Full history via paginated API fetch | 🔀 Group switching + 📅 calendar picker |
| ➕ Incremental archiving (resumable) | 🔍 In-place highlight for the day + search across all dates |
| 📆 Per-day JSON export | 📊 Statistics panel (daily activity / rankings / hours / word frequency) |
| ⏰ Scheduled jobs + manual Sync Now | 🧹 Red-packet / noise message filtering |
| | 🎯 Context-focus panel (trace a message's full story) |
| | 💬 Clickable quotes with original author attribution; @mention highlighting |
| | 🤖 AI daily summaries + agentic Q&A |
| | 🖼 Image proxy (bypasses hotlink protection), video links, share cards |
| | 🔔 Desktop notifications (mentions / keywords) + `@me` filter |

---

## 🚀 Quick Start

### 🖥 Download the app (recommended, macOS Apple Silicon)

1. Download `weibo-chat_*_aarch64.app.zip` from the [**latest release**](https://github.com/alloevil/weibo-chat-auto/releases/latest) and unzip it.
2. First launch: the app is not code-signed yet, so macOS Gatekeeper will block a normal double-click. **Right-click the .app → Open → Open** (only needed once).
3. Click 🔑 Login, scan the QR code with the Weibo app, then pick your groups under ⚙️ Settings → 归档群聊 — done.

> ⚠️ Currently **Apple Silicon (M1/M2/M3/M4) only** — there is no Intel or Windows/Linux build yet. The app is unsigned/un-notarized (no paid Apple Developer account), hence the right-click step. On other platforms, use the Web Version below.

### 🌐 Web Version (macOS / Linux / WSL)

```bash
git clone https://github.com/alloevil/weibo-chat-auto.git
cd weibo-chat-auto
npm run setup         # First time: install + configure + QR-code login
npm run view          # Afterwards: start the viewer → http://localhost:3456
```

### 🛠 Build the desktop app from source (developers)

```bash
git clone https://github.com/alloevil/weibo-chat-auto.git
cd weibo-chat-auto
npm run desktop
```

One command does it all: detect environment → install dependencies (Rust/Bun/npm) → build → launch. The first build takes ~10 minutes.

<details>
<summary><b>Desktop app architecture</b></summary>

- **Tauri v2** native window + WKWebView
- **Sidecar**: Bun compiles `scripts/viewer-server.js` into a ~60MB standalone binary, launched automatically on app start
- **Login**: Rust opens a WebView → scan QR code → `cookies_for_url()` extracts HttpOnly cookies → saved automatically
- **IPC**: WKWebView does not inject Tauri IPC; HTTP signaling is used instead
- **Images**: Weibo CDN checks the Referer header; the local `/api/sinaimg?url=` proxy bypasses it

</details>

<details>
<summary><b>Manual installation (step by step)</b></summary>

#### 1️⃣ Install dependencies

```bash
npm install
```

#### 2️⃣ Save cookies

```bash
npm run save-cookies
```

A **dedicated browser window** pops up (isolated from your everyday Chrome) and opens the Weibo chat page: scan the QR code with the Weibo app → confirm on your phone → once redirected to the chat list, cookies are written to `cookies.json` automatically.

#### 3️⃣ Configure groups

Copy the template and fill in group names (must match the names in Weibo **exactly** — or skip this step and pick groups in the viewer: ⚙️ Settings → 归档群聊):

```bash
cp config.example.json config.json
```

```json
{
    "chromePath": "",
    "groups": ["Group Name A", "Group Name B"]
}
```

> Leave `chromePath` empty to auto-detect Chrome on your system; only fill it in if Chrome is installed in a non-default location.

#### 4️⃣ Run & view

```bash
npm run archive   # First run fetches the last 7 days, incremental afterwards
npm run view      # Start the viewer → http://localhost:3456
```

> Port 3456 taken? Pick another one with `WEIBO_PORT=4000 npm run view`.

</details>

---

## 🔁 Daily Use

Just keep the viewer running:

```bash
npm run view
```

Open http://localhost:3456 → click **Sync Now** to fetch the latest messages (the page auto-refreshes every 60s).

<details>
<summary><b>Tips for reading history</b></summary>

- **🎯 Context**: a link on each message header opens a right-side panel showing its full story (the quoted original + surrounding messages + follow-up replies)
- **Quote jumps**: quote bubbles show the original author; click to jump to the original message and highlight it
- **Search**: typing highlights matches in-place within the current day (other messages stay visible, `n` / `N` to jump); it also searches across **all dates** — expand the results panel and click a row to jump straight to that day with the hit highlighted
- **@me**: the `@me` filter in the nav bar keeps only messages that mention you. The check-in bot @-mentions every member (93% of hits in practice) and is excluded unconditionally
- **Unread divider**: when you come back, a "new messages below" divider marks everything since your last visit

</details>

<details>
<summary><b>Cookie maintenance</b></summary>

Weibo ties the webim login state to a **24-hour rolling session** on the weibo.com side: the SUB cookie alone (nominally valid for a year) is not enough — if the rolling session lapses for a day, the login expires. The archiver and viewer have **automatic keep-alive** built in:

| Mechanism | Description |
| --- | --- |
| 🫀 Viewer keep-alive | While the viewer runs, the rolling session is renewed every 30 minutes (login state is verified first; guest cookies are never absorbed) |
| ✅ Renewal on every archive run | After a successful archive, the full browser cookie set is saved and the rolling session renewed along the way |
| ⚠ Expiry banner | When the session expires, a red banner appears at the top of the viewer immediately; clicking it opens the QR-code window |
| 🔄 `npm run save-cookies` | Re-scan when already expired (archived data is unaffected) |

So: **keep the viewer (or desktop app) running and the login essentially never expires**. If you stop everything for more than a day, or Weibo force-invalidates the session (device change, password change, risk control), you'll need to scan again — clicking Sync automatically pops up the QR-code window.

When cookies are invalid, the archiver **fails loudly with exit code 1** and tells you to run `npm run save-cookies`; it never pretends to succeed. Scheduled-job logs live in `logs/archive.log`; if `Cookie 已失效` (cookie expired) appears, it's time to re-scan:

```bash
grep -c "Cookie 已失效" logs/archive.log   # non-zero means you should re-scan
```

</details>

<details>
<summary><b>Live sync & sending messages</b></summary>

Live sync is **off by default**; enable it via the "Live" dropdown in the nav bar. When on, a green **Live** indicator appears: the server polls for new messages every 20 seconds, merges them into the day files, and pushes them to the page over SSE — new messages just show up, no need to click Sync Now (which remains the full "backfill history" archive). The input box at the bottom of the message area lets you post directly (Enter to send, Shift+Enter for a newline).

**Why off by default**: polling calls `query_messages` to read group messages, and whether reading advances Weibo's read cursor cannot be falsified from the outside — the endpoint's response carries `last_read_mid`, and the only way to observe it is through the same endpoint. If it did advance, the native Weibo client's unread badges would silently get eaten. Evidence suggests it does not (the webim client has a separate `clear_unread.json`, called only when you open a conversation), but that risk must be a choice you make explicitly.

The guarantee when off is **not a single request is sent**: no timers, the page doesn't even establish the SSE connection, and even the "nudge one sync round" after a successful send is skipped (your own message then appears with the next archive run). The toggle lives on the server (`live-config.json`), shared between the browser and desktop versions, takes effect immediately, no restart needed.

Both live sync and sending depend on the **group conversation id**. The archiver resolves it when clicking through groups and writes it to `state/last-archive-state_<group>.json`, so:

| State | Behavior |
| --- | --- |
| Archived at least once (v1.15.0+) | Live sync and sending both available |
| Never archived | The input box is hidden for that group with a "click Sync Now first" hint; live sync skips the group automatically |

Two more trade-offs:

- **No polling when nobody's watching**: once all pages are closed, polling stops immediately — no idle hammering of Weibo's API in the background.
- **No local echo of your own messages**: after a successful send, one live-sync round is nudged; your messages take exactly the same ingestion path as everyone else's, so the two sources can never conflict.
- **Desktop notifications**: by default only when **you are mentioned** (click to jump to the message). Settings let you add keyword subscriptions or enable "digest notification for every batch of new messages" (max 3 per round). Rules are evaluated server-side (`lib/notify-rules.js`) and noise is never notified — otherwise 93% of pushes would be the check-in bot. Permission is requested only once a rule is actually enabled.
- **Emoticons & images**: pick emoticons to the left of the input box (reuses the 340-entry official list used for rendering, inserts `[label]`), and send images too — file picker or paste, up to 20MB.

> The image upload endpoint (`/webim/uploadx.json`) was reverse-engineered from the webim frontend bundle and is **not yet verified against the real API** (once you really send one, there's no undo). If image sending fails, check the `[send]` line in `logs/` first.

⚠️ Sending messages is a write operation, and the viewer's API has no authentication (it only binds to `127.0.0.1`) — any program on your machine could post through it. Never expose the port to the internet.

</details>

---

## 🤖 AI Features

The viewer ships two AI features: **daily summaries** and **agentic Q&A**. Both require an OpenAI-compatible API.

### Configuration

⚙️ in the top-right corner of the page → fill in:

| Field | Description |
|------|------|
| Base URL | API endpoint (e.g. `https://api.deepseek.com/v1`) |
| API Key | Your key |
| Model | Model name (e.g. `deepseek-chat`) |
| Vision | Whether to analyze images during summarization |

Configuration is saved locally to `ai-config.json` (never committed to git).

### Q&A

Ask questions in the toolbar's Q&A box; natural-language time ("recently", "yesterday", "last week") and person filters are supported.

**Agent mode** (default): the LLM searches iteratively, choosing keywords and scope on its own, running multiple rounds until it has enough information.

<details>
<summary><b>Technical design</b></summary>

Uses the Agentic Search pattern; the loop mechanics draw on:
- [Hermes Agent](https://github.com/NousResearch/hermes-agent) — IterationBudget + grace call
- [Pi-Multi-Agent](https://github.com/jwangkun/Pi-Multi-Agent) — state machine + retry with backoff + timeout
- LedgerAgent paper — structured state accumulation

See [`docs/agent-qa.md`](docs/agent-qa.md) for details.

**Benchmark (Agent vs Legacy):**

| Metric | Agent | Legacy |
|------|-------|--------|
| Avg latency | 20.5s | 10.1s |
| Success rate | 100% | 100% |
| Date reasoning | Correct | Occasionally wrong |
| Search coverage | Multi-round expansion | Single pass |
| Answer quality | High | Medium |

</details>

---

## 📸 Screenshots

<details>
<summary><b>Click to expand</b></summary>

**Message view** — hourly heatmap, quote bubbles (with original author), @mention highlighting, per-message 🎯 context entry

![Message view](docs/screenshot-messages.png)

**Context focus** — click 🎯 to open the right-side panel: the quoted original + surrounding messages + follow-up replies

![Context panel](docs/screenshot-context.png)

**Statistics panel** — daily message volume, active-user rankings

![Statistics panel](docs/screenshot-stats.png)

> Usernames, group names, and avatars in the screenshots are anonymized samples.

</details>

---

<details>
<summary><b>✅ Prerequisites</b></summary>

| Required | Notes |
| --- | --- |
| 🖥 **macOS / Linux / WSL** | Archiver and viewer run cross-platform; scheduled-job installation is automatic on every platform (launchd / systemd / cron) |
| 🟢 **Node.js 18+** | [brew install node](https://brew.sh) (macOS) / `apt install nodejs` (Linux) / [nodejs.org](https://nodejs.org) |
| 🌐 **Google Chrome** | The archiver drives it for login and scraping; path is auto-detected |
| 📱 **Weibo account + mobile app** | First-time login to the web version requires scanning a QR code with the app |
| 🦀 **Rust + Bun** | Desktop app only; `npm run desktop` installs them automatically |

> Windows users, please use [WSL](https://learn.microsoft.com/windows/wsl/install); the desktop app has only been verified on macOS so far.

</details>

<details>
<summary><b>⏰ Scheduled runs</b></summary>

**All platforms** — `npm run setup` asks whether to enable this during installation; you can also manage the job any time with one command (macOS uses launchd, Linux uses a systemd user timer, and environments without systemd — e.g. some WSL distros — fall back to a crontab entry):

```bash
./scripts/schedule.sh install     # install (hourly archive)
./scripts/schedule.sh status      # check status
./scripts/schedule.sh uninstall   # remove cleanly
```

On systemd Linux the timer shows up under `systemctl --user list-timers weibo-archive.timer`. If the automatic installation fails, you can still configure cron by hand (`crontab -e`), archiving hourly:

```bash
0 * * * * cd /path/to/weibo-chat-auto && node scripts/auto-archive-simple.js >> logs/archive.log 2>&1
```

> With scheduling enabled, each archive run also refreshes the cookies, so they essentially never expire.

</details>

<details>
<summary><b>📁 Project layout</b></summary>

```text
weibo-chat-auto/
├── scripts/
│   ├── setup.sh                 # One-shot installer for the web version
│   ├── run-desktop.sh           # One-shot desktop launcher (deps → build → run)
│   ├── auto-archive-simple.js   # Main archiver script
│   ├── save-cookies.js          # Cookie saver
│   ├── viewer-server.js         # Local viewer server
│   ├── qa-agent.mjs             # Agentic Q&A module
│   └── …                        # Other helpers (QA index build, render smoke test, screenshots)
├── config.example.json          # Group configuration template
├── config.json                  # Actual configuration (not committed)
├── viewer.html                  # Viewer page (single-page app, Linear dark theme)
├── src-tauri/                   # Tauri v2 desktop app (Rust)
│   ├── src/lib.rs               # Window, sidecar launch, in-app login
│   └── tauri.conf.json
├── sidecar/build.mjs            # Compiles viewer-server into a standalone binary with Bun
├── cookies.json                 # Login credentials (not committed)
├── ai-config.json               # AI configuration (not committed)
├── state/                       # Archiver state (not committed)
├── output/                      # Archived data (not committed)
│   └── <group name>/
│       └── weibo_chat_2026-05-01.json
├── cache/images/                # Image cache (not committed)
├── docs/                        # Documentation and screenshots
│   └── agent-qa.md              # Agent Q&A technical design
└── package.json
```

</details>

<details>
<summary><b>🧾 Output data format</b></summary>

Each message:

```json
{
    "id": 123456789,
    "from_uid": 12345,
    "user": "username",
    "avatar": "https://...",
    "timestamp": 1778000000000,
    "time": "2026/05/11 12:00:00",
    "date": "2026-05-11",
    "content": "message content",
    "type": 321,
    "pics": ["https://upload.api.weibo.com/2/mss/msget?source=...&fid=..."],
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

</details>

---

## 🛠 Troubleshooting

<details>
<summary><b>Cookies expired</b> (sync errors, calendar not updating, "group not found" in logs)</summary>

```bash
npm run save-cookies
```

Scan the QR code and the cookies are saved automatically.

**Why do they expire?** The dedicated browser doesn't share your everyday login state, and Weibo's rolling session lapses after about a day without renewal. Keeping the viewer running (built-in 30-minute keep-alive) or having the scheduled job active renews it automatically.
</details>

<details>
<summary><b>Page fails to load</b></summary>

Check that `chromePath` in `config.json` is correct and that Google Chrome is installed.
</details>

<details>
<summary><b>Port 3456 already in use</b></summary>

The viewer prints a one-line hint and exits (most often the desktop app is already running — its server is the same one, just open http://localhost:3456). To run on a different port:

```bash
WEIBO_PORT=4000 npm run view
```
</details>

<details>
<summary><b>Images not showing</b></summary>

Images are proxied through the local server (which requires valid cookies), so they stop loading once cookies expire. Just run `npm run save-cookies` again.
</details>

---

## 🔒 Privacy Notice

> **This tool is intended only for archiving group chats you participate in. Do not use it to violate others' privacy.**

- Archived data contains message content, usernames, and avatars of all group members
- Keep `cookies.json` and `output/` safe; never share them publicly
- The code is for learning and research purposes; use at your own risk
- Comply with Weibo's Terms of Service and applicable laws

---

## 📄 License

[MIT](LICENSE)

---

<p align="center">
  <sub>⭐ Found it useful? Give it a star!</sub>
</p>
