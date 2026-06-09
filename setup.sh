#!/bin/bash
# 微博聊天自动归档 — 一键安装脚本
#
# 用法:
#   ./setup.sh          交互式安装（推荐）
#   ./setup.sh --yes    非交互安装，全部用默认值（不登录/不启用定时任务/不归档）
#   ./setup.sh --help   显示帮助
#
# 可重复运行（幂等）：已配置的步骤会跳过或覆盖。

set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
LABEL="com.allo.weibo-chat-archive"
LAUNCH_AGENTS="$HOME/Library/LaunchAgents"
PLIST_DEST="$LAUNCH_AGENTS/$LABEL.plist"

# ── 解析参数 ──────────────────────────────────────
ASSUME_YES=0
for arg in "$@"; do
    case "$arg" in
        -y|--yes) ASSUME_YES=1 ;;
        -h|--help)
            echo "用法: ./setup.sh [--yes] [--help]"
            echo "  --yes, -y   非交互安装：检查环境 + 装依赖 + 建 config，"
            echo "              跳过登录、定时任务与首次归档（用默认值）"
            echo "  --help, -h  显示本帮助"
            exit 0 ;;
        *) echo "未知参数: $arg（用 --help 查看用法）"; exit 1 ;;
    esac
done

# 是否进入交互（有 TTY 且未指定 --yes）
if [ -t 0 ] && [ "$ASSUME_YES" -eq 0 ]; then INTERACTIVE=1; else INTERACTIVE=0; fi

# ── 颜色 ──────────────────────────────────────────
BOLD=$'\033[1m'; GREEN=$'\033[32m'; YELLOW=$'\033[33m'; BLUE=$'\033[34m'; DIM=$'\033[2m'; RESET=$'\033[0m'
ok()   { echo "${GREEN}✓${RESET} $1"; }
info() { echo "${BLUE}›${RESET} $1"; }
warn() { echo "${YELLOW}⚠${RESET} $1"; }
step() { echo; echo "${BOLD}$1${RESET}"; }

echo "${BOLD}═══════════════════════════════════════${RESET}"
echo "${BOLD}  微博聊天自动归档 · 一键安装${RESET}"
echo "${BOLD}═══════════════════════════════════════${RESET}"
[ "$ASSUME_YES" -eq 1 ] && info "非交互模式（--yes）"

# ── 1. 检查运行环境 ──────────────────────────────
step "[1/5] 检查运行环境"

# 系统必须是 macOS（定时任务依赖 launchd）
if [ "$(uname -s)" != "Darwin" ]; then
    warn "本工具的定时任务依赖 macOS 的 launchd，当前系统不是 macOS。"
    echo "    归档与查看器在其他系统可能仍可手动运行，但 setup.sh 不支持。"
    exit 1
fi

# Node.js
NODE_BIN="$(command -v node || true)"
if [ -z "$NODE_BIN" ]; then
    warn "未找到 Node.js（必需）"
    echo "    安装方式任选其一："
    echo "      ${DIM}brew install node${RESET}   （需先装 Homebrew: https://brew.sh）"
    echo "      或从官网下载安装：https://nodejs.org （选 LTS 版）"
    exit 1
fi
NODE_DIR="$(dirname "$NODE_BIN")"
ok "Node.js $(node --version)  ${DIM}($NODE_BIN)${RESET}"

# Google Chrome（puppeteer 驱动它登录/抓取）
CHROME_APP="/Applications/Google Chrome.app"
if [ -d "$CHROME_APP" ]; then
    ok "Google Chrome 已安装"
else
    warn "未找到 Google Chrome（必需）"
    echo "    请先安装：https://www.google.com/chrome/"
    echo "    若装在非默认位置，安装后改 ${DIM}config.json${RESET} 的 chromePath。"
    exit 1
fi

# 2. 安装依赖
step "[2/5] 安装依赖"
( cd "$SCRIPT_DIR" && npm install --no-audit --no-fund )
mkdir -p "$SCRIPT_DIR/logs"
ok "依赖安装完成"

# ── 3. 配置群聊 ──────────────────────────────────
step "[3/5] 配置目标群聊"
if [ -f "$SCRIPT_DIR/config.json" ]; then
    ok "config.json 已存在，跳过"
    info "如需修改群聊，编辑 ${DIM}config.json${RESET} 的 groups 字段"
else
    cp "$SCRIPT_DIR/config.example.json" "$SCRIPT_DIR/config.json"
    if [ "$INTERACTIVE" -eq 1 ]; then
        echo "输入要归档的群名（必须与微博中的群名完全一致）"
        echo "${DIM}多个群用逗号分隔，直接回车则稍后手动编辑 config.json${RESET}"
        printf "群名: "
        read -r GROUPS_INPUT
        if [ -n "$GROUPS_INPUT" ]; then
            GROUPS_INPUT="$GROUPS_INPUT" node -e '
                const fs = require("fs");
                const cfg = JSON.parse(fs.readFileSync("config.json", "utf-8"));
                cfg.groups = process.env.GROUPS_INPUT
                    .split(/[,，]/).map(s => s.trim()).filter(Boolean);
                fs.writeFileSync("config.json", JSON.stringify(cfg, null, 2) + "\n");
            ' && ok "已写入群聊：$GROUPS_INPUT"
        else
            warn "已创建 config.json（占位群名），请手动编辑后再归档"
        fi
    else
        warn "已创建 config.json，请编辑 groups 字段填入真实群名"
    fi
fi

# ── 4. 登录（保存 Cookie）────────────────────────
step "[4/5] 登录微博"
if [ -f "$SCRIPT_DIR/cookies.json" ]; then
    ok "cookies.json 已存在，跳过登录"
    info "如需重新登录：${DIM}npm run save-cookies${RESET}"
elif [ "$INTERACTIVE" -eq 1 ]; then
    printf "现在扫码登录并保存 Cookie？[Y/n] "
    read -r ANS
    if [[ ! "$ANS" =~ ^[Nn] ]]; then
        ( cd "$SCRIPT_DIR" && npm run save-cookies )
    else
        warn "已跳过。首次归档前需运行：${DIM}npm run save-cookies${RESET}"
    fi
else
    warn "非交互环境，首次归档前需运行：${DIM}npm run save-cookies${RESET}"
fi

# ── 5. 定时任务（可选）───────────────────────────
step "[5/5] 定时自动归档（可选）"
install_plist() {
    mkdir -p "$LAUNCH_AGENTS"
    cat > "$PLIST_DEST" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>$LABEL</string>
    <key>ProgramArguments</key>
    <array>
        <string>$NODE_BIN</string>
        <string>$SCRIPT_DIR/auto-archive-simple.js</string>
    </array>
    <key>WorkingDirectory</key>
    <string>$SCRIPT_DIR</string>
    <key>StartInterval</key>
    <integer>3600</integer>
    <key>StandardOutPath</key>
    <string>$SCRIPT_DIR/logs/archive.log</string>
    <key>StandardErrorPath</key>
    <string>$SCRIPT_DIR/logs/archive-error.log</string>
    <key>EnvironmentVariables</key>
    <dict>
        <key>PATH</key>
        <string>$NODE_DIR:/usr/local/bin:/usr/bin:/bin</string>
    </dict>
</dict>
</plist>
PLIST
    launchctl unload "$PLIST_DEST" 2>/dev/null || true
    launchctl load "$PLIST_DEST"
    ok "定时任务已启用（每小时自动归档一次）"
    info "日志：${DIM}$SCRIPT_DIR/logs/archive.log${RESET}"
}

if [ "$INTERACTIVE" -eq 1 ]; then
    printf "启用定时自动归档（每小时一次，保持 Cookie 不过期）？[y/N] "
    read -r ANS
    if [[ "$ANS" =~ ^[Yy] ]]; then
        install_plist
    else
        info "已跳过。随时可重跑 ${DIM}./setup.sh${RESET} 启用"
    fi
else
    info "非交互环境，跳过定时任务设置"
fi

# ── 完成 ─────────────────────────────────────────
echo
echo "${BOLD}═══════════════════════════════════════${RESET}"
echo "${GREEN}${BOLD}  安装完成 🎉${RESET}"
echo "${BOLD}═══════════════════════════════════════${RESET}"
echo
echo "${BOLD}下一步：${RESET}"
echo "  ${BLUE}npm run archive${RESET}   手动归档一次"
echo "  ${BLUE}npm run view${RESET}      启动查看器 → http://localhost:3456"
echo
echo "${BOLD}定时任务管理：${RESET}"
echo "  ${DIM}launchctl list | grep weibo${RESET}                 查看状态"
echo "  ${DIM}launchctl unload $PLIST_DEST${RESET}   停用"
echo "  ${DIM}launchctl load   $PLIST_DEST${RESET}   启用"
echo

# ── 首次归档 + 打开查看器（交互式引导）──────────────
# 检测 config 是否仍是占位群名
HAS_REAL_GROUPS="no"
if [ -f "$SCRIPT_DIR/config.json" ]; then
    if node -e '
        const cfg = require("./config.json");
        const placeholder = ["群名称A","群名称B"];
        const real = (cfg.groups||[]).filter(g => !placeholder.includes(g));
        process.exit(real.length > 0 ? 0 : 1);
    ' 2>/dev/null; then HAS_REAL_GROUPS="yes"; fi
fi

if [ "$INTERACTIVE" -eq 1 ] && [ -f "$SCRIPT_DIR/cookies.json" ] && [ "$HAS_REAL_GROUPS" = "yes" ]; then
    printf "${BOLD}现在就归档一次并打开查看器？${RESET} [Y/n] "
    read -r ANS
    if [[ ! "$ANS" =~ ^[Nn] ]]; then
        info "开始归档（首次约需 1-2 分钟）..."
        ( cd "$SCRIPT_DIR" && npm run archive )
        info "启动查看器，浏览器将自动打开 http://localhost:3456"
        info "（按 ${DIM}Ctrl+C${RESET} 可停止查看器）"
        ( cd "$SCRIPT_DIR" && npm run view )
    fi
elif [ "$HAS_REAL_GROUPS" != "yes" ]; then
    warn "config.json 还是占位群名，请先填好真实群名再归档。"
fi
