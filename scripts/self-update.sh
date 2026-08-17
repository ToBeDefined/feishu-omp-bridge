#!/bin/bash
# 受控自更新——启动薄壳。
#
# 职责：找到可用的 python3 解释器并 exec 核心逻辑（scripts/self-update.py）。
# 仅做"定位解释器 + 转发参数"，不含任何业务逻辑。
#
# 为什么需要这一层（可靠性设计）：
#   - 自更新在"可能已改坏代码/环境"时被调用，依赖的 python3 若来自 brew
#     绝对路径可能在异常环境下失效。系统自带 /usr/bin/python3 永远存在。
#   - 核心逻辑（git pull / 门禁 / 回滚）在 self-update.py，保持可维护。
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# 定位 python3：优先系统自带（永在），其次 PATH（可能是 brew 新版）。
# macOS 的 /usr/bin/python3 是 shim，需实际运行验证而非仅 `-x`。
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
  echo "[self-update] 错误：找不到 python3，无法执行自更新。" >&2
  exit 1
}

exec "$PY" "$SCRIPT_DIR/self-update.py" "$@"
