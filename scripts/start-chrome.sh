#!/bin/bash
# 以调试模式启动 Chrome

CHROME_PATH="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
DEBUG_PORT=9222

echo "以调试模式启动 Chrome..."
echo "调试端口: $DEBUG_PORT"
echo ""
echo "请保持此终端窗口打开"
echo "在另一个终端运行: npm run archive"
echo ""
echo "按 Ctrl+C 停止"
echo ""

"$CHROME_PATH" --remote-debugging-port=$DEBUG_PORT
