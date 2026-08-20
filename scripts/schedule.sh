#!/bin/bash
# 定时归档任务的安装 / 卸载 / 状态查询（跨平台）。
#
# 用法:
#   ./scripts/schedule.sh install     安装定时任务（每小时归档一次）
#   ./scripts/schedule.sh uninstall   卸载定时任务
#   ./scripts/schedule.sh status      查看当前状态
#
# 平台分支：
#   macOS            → launchd（~/Library/LaunchAgents，与 setup.sh 历史行为一致）
#   Linux + systemd  → user-level 的 weibo-archive.service + .timer
#   Linux 无 systemd → crontab 条目（写入前查重，幂等）
# 日志统一落 logs/archive.log。可重复运行（幂等）。

set -e

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
LABEL="com.allo.weibo-chat-archive"
PLIST_DEST="$HOME/Library/LaunchAgents/$LABEL.plist"
UNIT_NAME="weibo-archive"
UNIT_DIR="${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user"
ARCHIVER="$ROOT_DIR/scripts/auto-archive-simple.js"

# ── 颜色（与 setup.sh 一致）──────────────────────
GREEN=$'\033[32m'; YELLOW=$'\033[33m'; BLUE=$'\033[34m'; DIM=$'\033[2m'; RESET=$'\033[0m'
ok()   { echo "${GREEN}✓${RESET} $1"; }
info() { echo "${BLUE}›${RESET} $1"; }
warn() { echo "${YELLOW}⚠${RESET} $1"; }

usage() {
    echo "用法: ./scripts/schedule.sh install|uninstall|status"
    exit "${1:-0}"
}

node_bin() {
    command -v node || { warn "未找到 Node.js"; exit 1; }
}

# systemd user 实例是否可用（WSL 里可能装了 systemctl 但没有 user bus）
has_systemd() {
    command -v systemctl >/dev/null 2>&1 && systemctl --user show-environment >/dev/null 2>&1
}

# ── launchd（macOS）──────────────────────────────
launchd_install() {
    local NODE_BIN NODE_DIR
    NODE_BIN="$(node_bin)"
    NODE_DIR="$(dirname "$NODE_BIN")"
    mkdir -p "$(dirname "$PLIST_DEST")" "$ROOT_DIR/logs"
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
        <string>$ARCHIVER</string>
    </array>
    <key>WorkingDirectory</key>
    <string>$ROOT_DIR</string>
    <key>StartInterval</key>
    <integer>3600</integer>
    <key>StandardOutPath</key>
    <string>$ROOT_DIR/logs/archive.log</string>
    <key>StandardErrorPath</key>
    <string>$ROOT_DIR/logs/archive-error.log</string>
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
    ok "定时任务已启用（launchd，每小时归档一次）"
    info "日志：${DIM}$ROOT_DIR/logs/archive.log${RESET}"
    info "卸载：${DIM}./scripts/schedule.sh uninstall${RESET}"
}

launchd_uninstall() {
    if [ -f "$PLIST_DEST" ]; then
        launchctl unload "$PLIST_DEST" 2>/dev/null || true
        rm -f "$PLIST_DEST"
        ok "已卸载 launchd 定时任务"
    else
        info "未安装 launchd 定时任务，无需卸载"
    fi
}

launchd_status() {
    if [ -f "$PLIST_DEST" ] && launchctl list 2>/dev/null | grep -q "$LABEL"; then
        ok "launchd 定时任务运行中（每小时归档一次）"
    else
        info "未安装定时任务"
    fi
}

# ── systemd（Linux）──────────────────────────────
systemd_install() {
    local NODE_BIN NODE_DIR
    NODE_BIN="$(node_bin)"
    NODE_DIR="$(dirname "$NODE_BIN")"
    mkdir -p "$UNIT_DIR" "$ROOT_DIR/logs"
    cat > "$UNIT_DIR/$UNIT_NAME.service" <<UNIT
[Unit]
Description=Weibo group chat archiver (weibo-chat-auto)

[Service]
Type=oneshot
WorkingDirectory=$ROOT_DIR
ExecStart=$NODE_BIN $ARCHIVER
Environment=PATH=$NODE_DIR:/usr/local/bin:/usr/bin:/bin
StandardOutput=append:$ROOT_DIR/logs/archive.log
StandardError=append:$ROOT_DIR/logs/archive-error.log
UNIT
    cat > "$UNIT_DIR/$UNIT_NAME.timer" <<UNIT
[Unit]
Description=Run weibo-chat-auto archiver hourly

[Timer]
OnCalendar=hourly
Persistent=true

[Install]
WantedBy=timers.target
UNIT
    systemctl --user daemon-reload
    systemctl --user enable --now "$UNIT_NAME.timer"
    ok "定时任务已启用（systemd user timer，每小时归档一次）"
    info "日志：${DIM}$ROOT_DIR/logs/archive.log${RESET}"
    info "查看：${DIM}systemctl --user list-timers $UNIT_NAME.timer${RESET}"
    info "卸载：${DIM}./scripts/schedule.sh uninstall${RESET}"
    # 用户会话退出后 timer 也会停；开机自启且不依赖登录需要 linger
    if command -v loginctl >/dev/null 2>&1 \
        && [ "$(loginctl show-user "$USER" --property=Linger --value 2>/dev/null)" = "no" ]; then
        info "提示：${DIM}loginctl enable-linger $USER${RESET} 可让 timer 不依赖登录会话"
    fi
}

systemd_uninstall() {
    if [ -f "$UNIT_DIR/$UNIT_NAME.timer" ] || [ -f "$UNIT_DIR/$UNIT_NAME.service" ]; then
        systemctl --user disable --now "$UNIT_NAME.timer" 2>/dev/null || true
        rm -f "$UNIT_DIR/$UNIT_NAME.timer" "$UNIT_DIR/$UNIT_NAME.service"
        systemctl --user daemon-reload
        ok "已卸载 systemd 定时任务"
    else
        info "未安装 systemd 定时任务，无需卸载"
    fi
}

systemd_status() {
    if systemctl --user is-enabled "$UNIT_NAME.timer" >/dev/null 2>&1; then
        ok "systemd 定时任务已启用（每小时归档一次）"
        systemctl --user list-timers "$UNIT_NAME.timer" --no-pager 2>/dev/null || true
    else
        info "未安装定时任务"
    fi
}

# ── cron（无 systemd 的 Linux / WSL 兜底）─────────
CRON_ENTRY_RE="scripts/auto-archive-simple\.js"

cron_install() {
    local NODE_BIN CRON_LINE CURRENT
    command -v crontab >/dev/null 2>&1 || { warn "未找到 crontab，无法安装定时任务"; exit 1; }
    NODE_BIN="$(node_bin)"
    mkdir -p "$ROOT_DIR/logs"
    CRON_LINE="0 * * * * cd $ROOT_DIR && $NODE_BIN scripts/auto-archive-simple.js >> logs/archive.log 2>&1"
    CURRENT="$(crontab -l 2>/dev/null || true)"
    if printf '%s\n' "$CURRENT" | grep -q "$CRON_ENTRY_RE"; then
        ok "crontab 条目已存在，跳过（幂等）"
    else
        printf '%s\n' "$CURRENT" "$CRON_LINE" | sed '/^$/d' | crontab -
        ok "定时任务已启用（cron，每小时归档一次）"
    fi
    info "日志：${DIM}$ROOT_DIR/logs/archive.log${RESET}"
    info "卸载：${DIM}./scripts/schedule.sh uninstall${RESET}"
}

cron_uninstall() {
    command -v crontab >/dev/null 2>&1 || { info "未找到 crontab，无需卸载"; return; }
    local CURRENT
    CURRENT="$(crontab -l 2>/dev/null || true)"
    if printf '%s\n' "$CURRENT" | grep -q "$CRON_ENTRY_RE"; then
        printf '%s\n' "$CURRENT" | grep -v "$CRON_ENTRY_RE" | crontab -
        ok "已移除 crontab 条目"
    else
        info "未安装 cron 定时任务，无需卸载"
    fi
}

cron_status() {
    if crontab -l 2>/dev/null | grep -q "$CRON_ENTRY_RE"; then
        ok "cron 定时任务已启用（每小时归档一次）"
        crontab -l 2>/dev/null | grep "$CRON_ENTRY_RE"
    else
        info "未安装定时任务"
    fi
}

# ── 平台分发 ─────────────────────────────────────
ACTION="${1:-}"
case "$ACTION" in
    install|uninstall|status) ;;
    -h|--help) usage 0 ;;
    *) usage 1 ;;
esac

if [ "$(uname -s)" = "Darwin" ]; then
    "launchd_$ACTION"
elif has_systemd; then
    # 卸载时把 cron 兜底条目也清掉（环境可能在两种方式间切换过）
    if [ "$ACTION" = "uninstall" ]; then systemd_uninstall; cron_uninstall; else "systemd_$ACTION"; fi
else
    "cron_$ACTION"
fi
