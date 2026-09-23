#!/bin/bash
# 微博聊天自动归档 — 一键安装脚本
#
# 用法:
#   ./scripts/setup.sh          交互式安装（推荐）
#   ./scripts/setup.sh --yes    非交互安装，全部用默认值（不登录/不启用定时任务/不归档）
#   ./scripts/setup.sh --help   显示帮助
#
# 可重复运行（幂等）：已配置的步骤会跳过或覆盖。

set -e

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT_DIR"

# ── 解析参数 ──────────────────────────────────────
ASSUME_YES=0
for arg in "$@"; do
    case "$arg" in
        -y|--yes) ASSUME_YES=1 ;;
        -h|--help)
            echo "用法: ./scripts/setup.sh [--yes] [--help]"
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

# 识别系统；Windows Git Bash 支持核心安装，但定时任务交给 Windows 任务计划程序。
OS="$(uname -s)"
WINDOWS_NATIVE=0
case "$OS" in
    Darwin) ok "系统：macOS" ;;
    Linux)
        if grep -qiE 'microsoft|wsl' /proc/version 2>/dev/null; then
            ok "系统：Linux (WSL)"
        else
            ok "系统：Linux"
        fi
        ;;
    MINGW*|MSYS*|CYGWIN*)
        WINDOWS_NATIVE=1
        ok "系统：Windows (Git Bash)"
        ;;
    *) warn "系统：$OS（未充分测试，归档与查看器可尝试运行）" ;;
esac

# Node.js
NODE_BIN="$(command -v node || true)"
if [ -z "$NODE_BIN" ]; then
    warn "未找到 Node.js（必需）"
    echo "    安装方式任选其一："
    echo "      ${DIM}brew install node${RESET}（macOS）/ ${DIM}apt install nodejs${RESET}（Linux）"
    echo "      或从官网下载：https://nodejs.org （选 LTS 版）"
    exit 1
fi
if ! NODE_VERSION_ERROR="$(node scripts/check-node-version.js 2>&1)"; then
    warn "$NODE_VERSION_ERROR"
    echo "    请从 https://nodejs.org 安装受支持的 LTS 版本。"
    exit 1
fi
ok "Node.js $(node --version)  ${DIM}($NODE_BIN)${RESET}"

# 2. 安装依赖
step "[2/5] 安装依赖"
( cd "$ROOT_DIR" && npm install --no-audit --no-fund )
mkdir -p "$ROOT_DIR/logs"
ok "依赖安装完成"

# ── 3. 配置群聊 ──────────────────────────────────
step "[3/5] 配置目标群聊"
if [ -f "$ROOT_DIR/config.json" ]; then
    ok "config.json 已存在，跳过"
    info "如需修改群聊，编辑 ${DIM}config.json${RESET} 的 groups 字段"
else
    cp "$ROOT_DIR/config.example.json" "$ROOT_DIR/config.json"
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

# 配置已存在/创建后再检查 Chrome。Node 从当前工作目录使用相对 require，避免
# Git Bash 的 /d/... MSYS 路径被原生 Windows Node 误解。
if CHROME_FOUND="$(node -e '
    const fs = require("fs");
    let configured = "";
    try { configured = require("./config.json").chromePath || ""; } catch {}
    try {
        const found = require("./lib/chrome-path").resolveChromePath(configured);
        if (!fs.existsSync(found)) throw new Error(`Chrome 路径不存在：${found}`);
        process.stdout.write(found);
    } catch (error) {
        console.error(error.message);
        process.exit(1);
    }
' 2>&1)"; then
    ok "Google Chrome：${DIM}${CHROME_FOUND}${RESET}"
else
    warn "未找到可用的 Google Chrome（必需）"
    echo "    $CHROME_FOUND"
    echo "    请安装 Chrome，或修改 ${DIM}config.json${RESET} 的 chromePath 后重试。"
    exit 1
fi

# ── 4. 登录（保存 Cookie）────────────────────────
step "[4/5] 登录微博"
if [ -f "$ROOT_DIR/cookies.json" ]; then
    ok "cookies.json 已存在，跳过登录"
    info "如需重新登录：${DIM}npm run save-cookies${RESET}"
elif [ "$INTERACTIVE" -eq 1 ]; then
    printf "现在扫码登录并保存 Cookie？[Y/n] "
    read -r ANS
    if [[ ! "$ANS" =~ ^[Nn] ]]; then
        ( cd "$ROOT_DIR" && npm run save-cookies )
    else
        warn "已跳过。首次归档前需运行：${DIM}npm run save-cookies${RESET}"
    fi
else
    warn "非交互环境，首次归档前需运行：${DIM}npm run save-cookies${RESET}"
fi

# ── 5. 定时任务（可选）───────────────────────────
step "[5/5] 定时自动归档（可选）"
# 平台分支（launchd / systemd / cron）统一在 scripts/schedule.sh
if [ "$WINDOWS_NATIVE" -eq 1 ]; then
    info "Windows 原生环境暂不自动配置计划任务；可使用 Windows 任务计划程序运行 npm run archive。"
elif [ "$INTERACTIVE" -eq 1 ]; then
    printf "启用定时自动归档（每小时一次，保持 Cookie 不过期）？[y/N] "
    read -r ANS
    if [[ "$ANS" =~ ^[Yy] ]]; then
        "$ROOT_DIR/scripts/schedule.sh" install
    else
        info "已跳过。随时可运行 ${DIM}./scripts/schedule.sh install${RESET} 启用"
    fi
else
    info "非交互环境，跳过定时任务设置（可运行 ${DIM}./scripts/schedule.sh install${RESET} 启用）"
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
if [ "$WINDOWS_NATIVE" -eq 0 ]; then
    echo "${BOLD}定时任务管理：${RESET}"
    echo "  ${DIM}./scripts/schedule.sh status${RESET}      查看状态"
    echo "  ${DIM}./scripts/schedule.sh install${RESET}     安装 / 启用"
    echo "  ${DIM}./scripts/schedule.sh uninstall${RESET}   卸载"
    echo
fi

# ── 首次归档 + 打开查看器（交互式引导）──────────────
# 检测 config 是否仍是占位群名
HAS_REAL_GROUPS="no"
if [ -f "$ROOT_DIR/config.json" ]; then
    if node -e '
        const cfg = require("./config.json");
        const placeholder = ["群名称A","群名称B"];
        const real = (cfg.groups||[]).filter(g => !placeholder.includes(g));
        process.exit(real.length > 0 ? 0 : 1);
    ' 2>/dev/null; then HAS_REAL_GROUPS="yes"; fi
fi

if [ "$INTERACTIVE" -eq 1 ] && [ -f "$ROOT_DIR/cookies.json" ] && [ "$HAS_REAL_GROUPS" = "yes" ]; then
    printf "${BOLD}现在就归档一次并打开查看器？${RESET} [Y/n] "
    read -r ANS
    if [[ ! "$ANS" =~ ^[Nn] ]]; then
        info "开始归档（首次约需 1-2 分钟）..."
        ( cd "$ROOT_DIR" && npm run archive )
        info "启动查看器，浏览器将自动打开 http://localhost:3456"
        info "（按 ${DIM}Ctrl+C${RESET} 可停止查看器）"
        ( cd "$ROOT_DIR" && npm run view )
    fi
elif [ "$HAS_REAL_GROUPS" != "yes" ]; then
    warn "config.json 还是占位群名，请先填好真实群名再归档。"
fi
