#!/bin/bash
# 微博聊天自动归档 - 安装脚本

set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

echo "=== 微博聊天自动归档 - 安装 ==="
echo ""

# 检查 Node.js
if ! command -v node &> /dev/null; then
    echo "错误: 未找到 Node.js，请先安装"
    exit 1
fi

echo "Node.js 版本: $(node --version)"

# 创建日志目录
mkdir -p "$SCRIPT_DIR/logs"
echo "✓ 创建日志目录"

# 检查 Cookie 文件
if [ ! -f "$SCRIPT_DIR/cookies.json" ]; then
    echo ""
    echo "⚠️  未找到 Cookie 文件"
    echo "请先运行: npm run save-cookies"
    echo "在浏览器中登录微博后，Cookie 会自动保存"
    echo ""
fi

# 安装 launchd 定时任务
PLIST_FILE="$SCRIPT_DIR/com.allo.weibo-chat-archive.plist"
LAUNCH_AGENTS="$HOME/Library/LaunchAgents"

if [ -f "$PLIST_FILE" ]; then
    # 复制到 LaunchAgents
    cp "$PLIST_FILE" "$LAUNCH_AGENTS/"
    echo "✓ 安装定时任务"

    # 加载定时任务
    launchctl load "$LAUNCH_AGENTS/com.allo.weibo-chat-archive.plist" 2>/dev/null || true
    echo "✓ 启用定时任务 (每天 9:00 运行)"
fi

echo ""
echo "=== 安装完成 ==="
echo ""
echo "使用方法:"
echo "  1. 首次使用: npm run save-cookies"
echo "  2. 手动运行: npm run archive"
echo "  3. 无头模式: npm run archive:headless"
echo ""
echo "定时任务:"
echo "  - 每天 9:00 自动运行"
echo "  - 日志位置: /Users/allo/weibo-chat-auto/logs/"
echo ""
echo "管理定时任务:"
echo "  查看状态: launchctl list | grep weibo"
echo "  停用: launchctl unload ~/Library/LaunchAgents/com.allo.weibo-chat-archive.plist"
echo "  启用: launchctl load ~/Library/LaunchAgents/com.allo.weibo-chat-archive.plist"
