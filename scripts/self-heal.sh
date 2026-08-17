#!/bin/bash
# 自愈看门狗——启动薄壳。
#
# 职责：找到可用的 python3 解释器并 exec 核心逻辑（scripts/self-heal.py）。
# 仅做"定位解释器 + 转发参数"，不含任何业务逻辑。
#
# 为什么需要这一层（可靠性设计）：
#   - launchd 直接拉 brew 的 python3 绝对路径（如
#     /opt/homebrew/opt/python@3.14/bin/python3.14）是 brew 管理的 symlink，
#     brew upgrade/cleanup 后可能失效。自愈工具恰好在"系统可能出问题"时
#     才被调用，不能依赖一个可能失效的解释器路径。
#   - 系统自带 /usr/bin/python3（macOS 3.9+）与 /bin/bash 永远存在，
#     作为第一优先，保证 watchdog 在 brew python 失效时仍能启动。
#
# 核心逻辑（探测/状态/退避/修复）在 self-heal.py，保持可维护（JSON 原生、
# 多行提示词、pytest 可测）。这一层刻意保持极薄，避免逻辑分散到两个语言。
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# 定位 python3：优先系统自带（永在），其次 PATH（可能是 brew 新版）。
# 注意：macOS 的 /usr/bin/python3 是 shim，`-x` 存在但可能因系统策略
# 无法真正执行 —— 所以用实际运行 `--version` 验证，而非仅检查文件存在。
find_python() {
  if [ -x /usr/bin/python3 ] && /usr/bin/python3 --version >/dev/null 2>&1; then
    echo /usr/bin/python3
    return 0
  fi
  local p
  p="$(command -v python3 2>/dev/null || true)"
  if [ -n "$p" ] && "$p" --version >/dev/null 2>&1; then
    echo "$p"
    return 0
  fi
  return 1
}

PY="$(find_python)" || {
  echo "[self-heal] 错误：找不到 python3，无法执行自愈逻辑。" >&2
  exit 1
}

exec "$PY" "$SCRIPT_DIR/self-heal.py" "$@"

