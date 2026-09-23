#!/bin/bash
# 微博群聊桌面应用 — 一键启动
# 自动检测并安装 Rust、Bun，编译 sidecar，启动桌面 app
set -e

cd "$(dirname "$0")/.."

echo "🖥  微博群聊桌面应用"
echo ""

# Check Node.js
if ! command -v node &>/dev/null; then
    echo "❌ 需要 Node.js，请先安装: https://nodejs.org"
    exit 1
fi
if ! NODE_VERSION_ERROR="$(node scripts/check-node-version.js 2>&1)"; then
    echo "❌ $NODE_VERSION_ERROR"
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

# Install npm deps if missing or stale. Merely having node_modules is not enough:
# after a git pull it can still be missing a newly added runtime package.
if ! node scripts/check-dependencies.js >/dev/null 2>&1; then
    echo "📦 安装或同步 npm 依赖..."
    npm install --no-audit --no-fund
fi

# Build sidecar binary
SIDECAR="src-tauri/binaries/viewer-server-$(rustc --print host-tuple)"
SIDECAR_STALE=0
if [ ! -f "$SIDECAR" ]; then
    SIDECAR_STALE=1
elif [ "viewer.html" -nt "$SIDECAR" ] || [ "scripts/viewer-server.js" -nt "$SIDECAR" ] \
    || find lib -type f -name '*.js' -newer "$SIDECAR" -print -quit | grep -q .; then
    SIDECAR_STALE=1
fi
if [ "$SIDECAR_STALE" -eq 1 ]; then
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
