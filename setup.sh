#!/bin/bash
# 微博聊天自动归档 — 一键安装脚本
#
# 用法: ./setup.sh
# 可重复运行（幂等）：已配置的步骤会跳过或覆盖。

set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
LABEL="com.allo.weibo-chat-archive"
LAUNCH_AGENTS="$HOME/Library/LaunchAgents"
PLIST_DEST="$LAUNCH_AGENTS/$LABEL.plist"

# ── 颜色 ──────────────────────────────────────────
BOLD=$'\033[1m'; GREEN=$'\033[32m'; YELLOW=$'\033[33m'; BLUE=$'\033[34m'; DIM=$'\033[2m'; RESET=$'\033[0m'
ok()   { echo "${GREEN}✓${RESET} $1"; }
info() { echo "${BLUE}›${RESET} $1"; }
warn() { echo "${YELLOW}⚠${RESET} $1"; }
step() { echo; echo "${BOLD}$1${RESET}"; }

echo "${BOLD}═══════════════════════════════════════${RESET}"
echo "${BOLD}  微博聊天自动归档 · 一键安装${RESET}"
echo "${BOLD}═══════════════════════════════════════${RESET}"

# ── 1. 检查 Node.js ──────────────────────────────
step "[1/5] 检查 Node.js"
NODE_BIN="$(command -v node || true)"
if [ -z "$NODE_BIN" ]; then
    warn "未找到 Node.js"
    echo "    请先安装：${DIM}brew install node${RESET}  或访问 https://nodejs.org"
    exit 1
fi
NODE_DIR="$(dirname "$NODE_BIN")"
ok "Node.js $(node --version)  ${DIM}($NODE_BIN)${RESET}"

# ── 2. 安装依赖 ──────────────────────────────────
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
    if [ -t 0 ]; then
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
elif [ -t 0 ]; then
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

if [ -t 0 ]; then
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
