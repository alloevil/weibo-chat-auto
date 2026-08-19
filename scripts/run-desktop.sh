#!/bin/bash
# 微博群聊桌面应用 — 一键启动
# 自动检测并安装 Rust、Bun，编译 sidecar，启动桌面 app
set -e

cd "$(dirname "$0")"

echo "🖥  微博群聊桌面应用"
echo ""

# Check Node.js
if ! command -v node &>/dev/null; then
    echo "❌ 需要 Node.js，请先安装: https://nodejs.org"
    exit 1
fi

# Check/Install Rust
if ! command -v cargo &>/dev/null; then
    echo "📦 安装 Rust..."
    curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y
    source "$HOME/.cargo/env"
fi

# Check/Install Bun
if ! command -v bun &>/dev/null; then
    echo "📦 安装 Bun..."
    curl -fsSL https://bun.sh/install | bash
    export BUN_INSTALL="$HOME/.bun"
    export PATH="$BUN_INSTALL/bin:$PATH"
fi

# Install npm deps if needed
if [ ! -d "node_modules" ]; then
    echo "📦 安装 npm 依赖..."
    npm install
fi

# Build sidecar binary
SIDECAR="src-tauri/binaries/viewer-server-$(rustc --print host-tuple)"
if [ ! -f "$SIDECAR" ]; then
    echo "🔨 编译 sidecar..."
    node sidecar/build.mjs
fi

# Copy sidecar to dev location
TARGET_DIR="src-tauri/target/debug"
mkdir -p "$TARGET_DIR"
cp "$SIDECAR" "$TARGET_DIR/$(basename "$SIDECAR")"

# Run
echo ""
echo "🚀 启动桌面应用..."
cd src-tauri
cargo run
