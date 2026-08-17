#!/usr/bin/env bash
# 自愈看门狗：定期健康探测 bridge daemon，异常时自动修复。
#
# 探测维度（每 60s，连续 FAIL_THRESHOLD 次异常才算"假死"）：
#   1. 进程存活  —— 有 feishu-omp-bridge.mjs run 进程
#   2. WS 连通    —— ~/.feishu-omp-bridge/processes.json 里存在带 botName 的条目
#                    （botName 只在飞书 WS 握手成功后写入）
#   3. agent 可用 —— `omp --version` 能 5 秒内返回
#
# 修复策略（由轻到重）：
#   A. bridge restart              —— 进程死了 / 进程活着但没连上
#   B. omp run 一次"修复"会话       —— restart 后仍假死，带错误上下文让它诊断修复
#
# 用法：
#   scripts/self-heal.sh          # 前台跑一轮（配合 launchd KeepAlive 常驻）
#   scripts/self-heal.sh --once   # 只探测一轮，不进入循环（手动/CI 用）
#   scripts/self-heal.sh install  # 注册 launchd watchdog 常驻服务
#   scripts/self-heal.sh uninstall
#
# 设计要点：
#   - flock 互斥：与 self-update 不同锁，避免 watchdog 在自更新中途重启。
#   - 探测阈值可调；状态记录在 ~/.feishu-omp-bridge/heal-state.json。
#   - 唤起 omp 修复是非交互单轮：--mode rpc --print-json-lines，超时保护。

set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# Test hooks (override via env): isolate state/log, fake the bridge bin,
# the omp binary, the pgrep pattern, and the post-repair wait.
STATE_DIR="${HEAL_STATE_DIR:-${HOME}/.feishu-omp-bridge}"
STATE_FILE="${STATE_DIR}/heal-state.json"
LOCK_FILE="${HEAL_LOCK_FILE:-${TMPDIR:-/tmp}/feishu-omp-bridge-self-heal.lock}"
LOG_FILE="${STATE_DIR}/logs/heal.log"
RESTART_CMD="${HEAL_RESTART_CMD:-node ${REPO}/bin/feishu-omp-bridge.mjs}"
OMP_BIN="${HEAL_OMP_BIN:-omp}"
PGREP_PATTERN="${HEAL_PGREP_PATTERN:-feishu-omp-bridge.mjs run}"
RECOVER_WAIT_S="${HEAL_RECOVER_WAIT_S:-5}"

INTERVAL_S="${HEAL_INTERVAL_S:-60}"
FAIL_THRESHOLD="${HEAL_FAIL_THRESHOLD:-3}"
OMP_TIMEOUT_S="${HEAL_OMP_TIMEOUT_S:-300}"
HEAL_MODEL="${HEAL_MODEL:-futu/deepseek-v4-flash-0731}"
HEAL_BACKOFF_BASE_S="${HEAL_BACKOFF_BASE_S:-60}"
HEAL_BACKOFF_MAX_S="${HEAL_BACKOFF_MAX_S:-480}"
HEAL_MAX_ATTEMPTS="${HEAL_MAX_ATTEMPTS:-10}"

mkdir -p "$(dirname "$LOG_FILE")"

log() { echo "[$(date '+%F %T')] $*" | tee -a "$LOG_FILE"; }

# Portable mutual exclusion (macOS has no flock(1)): atomic mkdir lock.
LOCK_DIR="${LOCK_FILE}.d"
if ! mkdir "$LOCK_DIR" 2>/dev/null; then
  log "✗ 已有自愈看门狗在运行，本轮跳过。"
  exit 2
fi
trap 'rmdir "$LOCK_DIR" 2>/dev/null || true' EXIT

# --- 健康探测 ---
probe() {
  local healthy=1
  # 1. 进程存活
  if ! pgrep -f "$PGREP_PATTERN" >/dev/null 2>&1; then
    log "✗ 进程不存在"
    healthy=0
  fi
  # 2. WS 连通（processes.json 有 botName = 飞书握手成功）
  if [ ! -f "$STATE_DIR/processes.json" ] || \
     ! grep -q '"botName"' "$STATE_DIR/processes.json"; then
    log "✗ 未检测到 WS 连接(processes.json 无 botName)"
    healthy=0
  fi
  # 3. agent 可用
  if ! timeout 5 "$OMP_BIN" --version >/dev/null 2>&1; then
    log "✗ omp 不可用"
    healthy=0
  fi
  [ "$healthy" = 1 ]
}

# 读取/写入 state JSON（合并语义，避免覆盖其它字段）。
# 字段：fails(连续异常计数) / lastCheck / ompAttempts(修复重试次数) /
#       nextOmpAt(下次允许唤起 omp 的 epoch 秒，用于阶梯退避)
read_fails() { python3 -c "import json;print(json.load(open('$STATE_FILE')).get('fails',0))" 2>/dev/null || echo 0; }
state_get() { python3 -c "import json;print(json.load(open('$STATE_FILE')).get('$1',0))" 2>/dev/null || echo 0; }
state_set() {
  python3 - "$STATE_FILE" "$@" <<'PY'
import json, sys
f = sys.argv[1]
try:
    d = json.load(open(f))
except Exception:
    d = {}
for i in range(2, len(sys.argv), 2):
    d[sys.argv[i]] = sys.argv[i + 1]
json.dump(d, open(f, 'w'))
PY
}
write_fails() { state_set fails "$1" lastCheck "$(date '+%FT%T')"; }

repair_restart() {
  log "→ 执行 bridge restart 拉回..."
  if $RESTART_CMD; then
    log "✓ restart 成功，等待探测恢复..."
    sleep "$RECOVER_WAIT_S"
    if probe; then
      write_fails 0
      log "✓ 自愈完成（restart）"
      return 0
    fi
  fi
  return 1
}

# 唤起一个 omp 修复会话：带错误上下文，让它自行诊断修复。
repair_with_omp() {
  log "→ 唤起 omp 修复会话（restart 仍失败）..."
  local ctx=""
  ctx+="任务：修复 feishu-omp-bridge 守护进程，使其恢复在线。\n"
  ctx+="背景：bridge 反复 restart 后仍未在 30 秒内连上飞书（自愈 watchdog 触发）。\n"
  ctx+="\n"
  ctx+="必须严格按顺序执行：\n"
  ctx+="  1. 诊断：查看日志定位根因\n"
  ctx+="     tail -50 ${STATE_DIR}/logs/daemon-stderr.log\n"
  ctx+="     tail -50 ${STATE_DIR}/logs/daemon-stdout.log\n"
  ctx+="  2. 修复：按根因处理。常见：dist 与源码不一致(运行 pnpm build)、\n"
  ctx+="     依赖损坏(pnpm install)、launchd plist 异常($RESTART_CMD start 重装)、\n"
  ctx+="     飞书凭据失效。若是代码问题，改源码后 pnpm typecheck && pnpm test && pnpm build。\n"
  ctx+="  3. 启动：运行 $RESTART_CMD restart，然后验证 $RESTART_CMD status 显示\"正在后台运行\"。\n"
  ctx+="  4. 结束：确认在线后，输出一句话结论（修复了什么、当前是否在线），立即停止。\n"
  ctx+="\n"
  ctx+="成功标准：$RESTART_CMD status 显示 daemon 在线（\"正在后台运行\"或\"正在运行\"）。\n"
  ctx+="\n"
  ctx+="硬性约束：\n"
  ctx+="  - 只做 bridge 自愈这一件事，禁止任何无关的改动/重构/优化/新功能。\n"
  ctx+="  - 禁止询问用户或等待确认，直接执行，非交互。\n"
  ctx+="  - 步骤 1-4 全部完成（无论成败）后必须结束，不要继续探索、不要追加任务。\n"
  ctx+="  - 若按上述仍无法修复：输出失败结论 + 最后诊断，然后结束。\n"
  ctx+="\n"
  ctx+="仓库路径：$REPO"

  if timeout "$OMP_TIMEOUT_S" "$OMP_BIN" run --cwd "$REPO" \
      --print-json-lines --model "$HEAL_MODEL" "$ctx" >/dev/null 2>&1; then
    log "✓ omp 修复会话已执行"
    # 修复后复查一轮
    sleep "$RECOVER_WAIT_S"
    if probe; then
      write_fails 0
      state_set ompAttempts 0 nextOmpAt 0
      log "✓ 自愈完成（omp 修复）"
      return 0
    fi
  else
    log "✗ omp 修复会话失败或超时"
  fi
  return 1
}

# omp 修复的调度层：并发锁 + 阶梯退避。
# 锁：同一时间只允许一个 omp 修复会话（防多轮失败并发唤起互相踩）。
# 退避：失败后按 2/4/8... 分钟递增（上限 HEAL_BACKOFF_MAX_S），
#       期间不再唤起 omp；restart 仍每轮阈值都试（轻量）。
repair_with_omp_guarded() {
  local now next attempts backoff
  now="$(date +%s)"
  # 已达最大修复次数 → 彻底停止，不再唤起 omp（避免无限空转）。
  attempts="$(state_get ompAttempts)"
  if [ "${attempts:-0}" -ge "$HEAL_MAX_ATTEMPTS" ]; then
    log "✗ 已到达 omp 修复次数上限 ${HEAL_MAX_ATTEMPTS}，停止自愈。需人工介入："
    log "    查看日志: tail -f ${STATE_DIR}/logs/daemon-stderr.log"
    return 1
  fi
  next="$(state_get nextOmpAt)"
  if [ "$next" -gt "$now" ]; then
    log "⏳ omp 修复退避中（剩 $((next-now))s）"
    return 1
  fi
  local omp_lock="${LOCK_FILE}.omp.d"
  if ! mkdir "$omp_lock" 2>/dev/null; then
    log "✗ 已有 omp 修复会话在运行，跳过本轮"
    return 1
  fi
  if repair_with_omp; then
    rmdir "$omp_lock" 2>/dev/null || true
    return 0
  fi
  rmdir "$omp_lock" 2>/dev/null || true
  # 阶梯退避：2^attempts 分钟，上限 HEAL_BACKOFF_MAX_S
  backoff=$(( (2 ** attempts) * HEAL_BACKOFF_BASE_S ))
  [ "$backoff" -gt "$HEAL_BACKOFF_MAX_S" ] && backoff="$HEAL_BACKOFF_MAX_S"
  state_set ompAttempts "$((attempts + 1))" nextOmpAt "$((now + backoff))"
  if [ $((attempts + 1)) -ge "$HEAL_MAX_ATTEMPTS" ]; then
    log "⏳ omp 修复失败（第 $((attempts + 1))/${HEAL_MAX_ATTEMPTS} 次），已达上限，停止自愈。需人工介入。"
  else
    log "⏳ omp 修复失败，退避 ${backoff}s 后重试（第 $((attempts + 1))/${HEAL_MAX_ATTEMPTS} 次）"
  fi
  return 1
}

heal_once() {
  if probe; then
    write_fails 0
    return 0
  fi
  local fails
  fails=$(( $(read_fails) + 1 ))
  write_fails "$fails"
  log "连续异常 ${fails}/${FAIL_THRESHOLD}"
  if [ "$fails" -ge "$FAIL_THRESHOLD" ]; then
    write_fails 0  # 重置，避免阈值耗尽后每轮都打 omp
    if repair_restart; then
      return 0
    fi
    repair_with_omp_guarded || true
  fi
}

case "${1:-}" in
  --once)
    heal_once
    ;;
  --repair)
    # Standalone repair: just run the guarded omp repair (used by
    # `bridge restart`/`start` under SELF_HEAL=1, where the restart has
    # already failed inside the CLI). No probing/threshold bookkeeping.
    repair_with_omp_guarded
    ;;
  install)
    PLIST="${HOME}/Library/LaunchAgents/ai.feishu-omp-bridge.heal.plist"
    BASH_BIN="$(command -v bash)"
    cat > "$PLIST" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>ai.feishu-omp-bridge.heal</string>
    <key>ProgramArguments</key>
    <array>
        <string>${BASH_BIN}</string>
        <string>${REPO}/scripts/self-heal.sh</string>
    </array>
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <true/>
    <key>ThrottleInterval</key>
    <integer>10</integer>
    <key>StandardOutPath</key>
    <string>${STATE_DIR}/logs/heal.log</string>
    <key>StandardErrorPath</key>
    <string>${STATE_DIR}/logs/heal.log</string>
    <key>EnvironmentVariables</key>
    <dict>
        <key>PATH</key>
        <string>${PATH}</string>
    </dict>
</dict>
</plist>
EOF
    launchctl bootstrap "gui/$(id -u)" "$PLIST"
    log "✓ watchdog 已注册并启动 (ai.feishu-omp-bridge.heal)"
    ;;
  uninstall)
    launchctl bootout "gui/$(id -u)/ai.feishu-omp-bridge.heal" 2>/dev/null || true
    rm -f "${HOME}/Library/LaunchAgents/ai.feishu-omp-bridge.heal.plist"
    log "✓ watchdog 已卸载"
    ;;
  *)
    # 常驻循环（launchd 拉起后用）
    while true; do
      heal_once
      sleep "$INTERVAL_S"
    done
    ;;
esac
