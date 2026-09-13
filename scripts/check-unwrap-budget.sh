#!/bin/sh
# 棘轮：`.unwrap()` / `.expect(` 的数量只许减少，超过预算就失败。
#
# 这两种调用会让 Rust 侧遇到错误直接 panic——对桌面应用意味着用户看到进程消失而不是错误提示。
# 现有两处是 Tauri 运行入口与状态锁，暂时保留；新增一处就要先想清楚，或把预算调高并说明理由。
#
# 用法：scripts/check-unwrap-budget.sh           （CI 与本地一致）
#       scripts/check-unwrap-budget.sh --update  （把预算降到当前值，只许往下调）
set -eu

script_dir=$(cd -- "$(dirname -- "$0")" && pwd)
repo_root=$(dirname -- "$script_dir")
budget_file="$repo_root/src-tauri/unwrap-budget.txt"
src_dir="$repo_root/src-tauri/src"

if [ ! -f "$budget_file" ]; then
    echo "missing budget file: $budget_file" >&2
    exit 1
fi
budget=$(tr -d ' \n' < "$budget_file")
case "$budget" in
    '' | *[!0-9]*)
        echo "budget must be a single integer, got: $budget" >&2
        exit 1
        ;;
esac

if [ ! -d "$src_dir" ]; then
    echo "missing source dir: $src_dir" >&2
    exit 1
fi

sites=$(grep -rn -E '\.unwrap\(\)|\.expect\(' "$src_dir" --include='*.rs' || true)
count=0
if [ -n "$sites" ]; then
    count=$(printf '%s\n' "$sites" | wc -l | tr -d ' ')
fi

echo "unwrap/expect budget: $budget, found: $count"
printf '%s\n' "$sites" | sed 's|^|  |'

if [ "$count" -gt "$budget" ]; then
    echo "::error::unwrap/expect count rose from $budget to $count — handle the error or raise the budget on purpose" >&2
    exit 1
fi

if [ "$count" -lt "$budget" ]; then
    echo "budget can be lowered from $budget to $count: run scripts/check-unwrap-budget.sh --update"
    if [ "${1:-}" = "--update" ]; then
        printf '%s\n' "$count" > "$budget_file"
        echo "budget updated to $count"
    fi
fi
