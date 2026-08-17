#!/usr/bin/env bash
# self-heal.sh 端到端自动测试（隔离环境，多轮）。
#
# 隔离手段：
#   - HEAL_STATE_DIR   → 临时目录，不碰生产 ~/.feishu-omp-bridge
#   - HEAL_RESTART_CMD → 假 restart 脚本（可控成功/失败/是否修复状态）
#   - HEAL_OMP_BIN     → 假 omp（可控成功/失败）
#   - HEAL_PGREP_PATTERN → 匹配临时假进程，不匹配生产 daemon
#   - HEAL_LOCK_FILE   → 临时锁
#
# 每类场景跑 N 轮（默认 3），全部通过才算绿。
#
# 用法：
#   scripts/verify-self-heal.sh [rounds]

set -euo pipefail

HEAL="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/self-heal.sh"
ROUNDS="${1:-3}"
FAILS=0
TOTAL=0
PROBE_PID=""

# --- 工具 ---
T=$(mktemp -d /tmp/heal-test.XXXXXX)
export T
trap 'rm -rf "$T"' EXIT

# 假 omp: 可切换 --version / run 成败；OMP_RUN_CALLS 记录 run 次数
mk_fake_omp() {
  mkdir -p "$T/omp"
  cat > "$T/omp/fake-omp" <<'EOF'
#!/usr/bin/env bash
if [ "$1" = "--version" ]; then
  [ "${OMP_OK:-1}" = 1 ] && exit 0 || exit 1
fi
if [ "$1" = "run" ]; then
  echo "run" >> "$T/omp/calls.log"
  # 保存最后一个参数（ctx 提示词）供契约断言
  echo "${@: -1}" > "$T/omp/last-ctx.txt"
  [ "${OMP_RUN_OK:-0}" = 1 ] && exit 0 || exit 1
fi
exit 1
EOF
  chmod +x "$T/omp/fake-omp"
}

# 假 restart: RESTART_OK=1 成功; RESTART_FIX=1 后写回 botName(模拟修复)
mk_fake_restart() {
  mkdir -p "$T/bin"
  cat > "$T/bin/fake-restart" <<'EOF'
#!/usr/bin/env bash
echo "RESTART_CALLS=$((${RESTART_CALLS:-0}+1))" > "$T/bin/calls.env"
[ "${RESTART_FIX:-0}" = 1 ] && printf '{"entries":[{"botName":"Agent","pid":123}]}' > "$T/state/processes.json"
[ "${RESTART_OK:-1}" = 1 ]
EOF
  chmod +x "$T/bin/fake-restart"
}

# 启动/停止一个匹配 PROBE_PATTERN 的假 bridge 进程
PROBE_PATTERN="heal-probe-process-$$"
start_proc() {
  ( exec -a "$PROBE_PATTERN" sleep 3600 ) &
  PROBE_PID=$!
}
stop_proc() {
  [ -n "$PROBE_PID" ] && kill "$PROBE_PID" 2>/dev/null || true
  PROBE_PID=""
}

# 执行一轮 heal（捕获其行为副作用到 $T）。
# 显式透传 OMP_*/RESTART_* 给子进程（fake 脚本读取）。
run_heal() {
  TOTAL=$((TOTAL+1))
  HEAL_STATE_DIR="$T/state" \
  HEAL_LOCK_FILE="$T/heal.lock" \
  HEAL_RESTART_CMD="bash $T/bin/fake-restart" \
  HEAL_OMP_BIN="$T/omp/fake-omp" \
  HEAL_PGREP_PATTERN="$PROBE_PATTERN" \
  HEAL_RECOVER_WAIT_S=0 \
  HEAL_FAIL_THRESHOLD=2 \
  HEAL_BACKOFF_BASE_S="${HEAL_BACKOFF_BASE_S:-0}" \
  HEAL_MAX_ATTEMPTS="${HEAL_MAX_ATTEMPTS:-10}" \
  OMP_OK="${OMP_OK:-1}" OMP_RUN_OK="${OMP_RUN_OK:-0}" \
  RESTART_OK="${RESTART_OK:-1}" RESTART_FIX="${RESTART_FIX:-0}" \
  bash "$HEAL" --once >/dev/null 2>&1 || true
}

reset_round() {
  rm -rf "$T/state" "$T/heal.lock" "$T/heal.lock.d" "$T/heal.lock.omp.d" \
         "$T/bin" "$T/omp" "$T/calls.env"
  mkdir -p "$T/state"
  mk_fake_omp
  mk_fake_restart
  rm -f "$T/bin/calls.env" "$T/omp/calls.env" "$T/omp/calls.log" "$T/omp/last-ctx.txt"
  stop_proc
}

check() {
  local name="$1" cond="$2"
  if eval "$cond"; then
    printf '  ✓ %s\n' "$name"
  else
    printf '  ✗ %s\n' "$name"
    FAILS=$((FAILS+1))
  fi
}

state_fails() {
  python3 -c "import json;print(json.load(open('$T/state/heal-state.json'))['fails'])" 2>/dev/null || echo "MISSING"
}

echo "== self-heal 端到端测试（$ROUNDS 轮）=="
for round in $(seq 1 "$ROUNDS"); do
  echo "— 第 ${round}/${ROUNDS} 轮 —"
  reset_round

  # === 场景 1: 健康（进程在 + botName 在 + omp 在）→ 不误报 ===
  OMP_OK=1 RESTART_OK=1 RESTART_FIX=0
  printf '{"entries":[{"botName":"Agent","pid":123}]}' > "$T/state/processes.json"
  start_proc
  run_heal
  check "健康时 fails=0" "[ \"$(state_fails)\" = 0 ]"
  check "健康时未触发 restart" "[ ! -f $T/bin/calls.env ]"
  stop_proc

  # === 场景 2: 进程死 → 连续异常达阈值 → restart 自愈 ===
  reset_round
  OMP_OK=1 RESTART_OK=1 RESTART_FIX=1
  printf '{"entries":[{"botName":"Agent","pid":123}]}' > "$T/state/processes.json"
  run_heal   # 第1次异常
  check "第1次异常计入 fails=1" "[ \"$(state_fails)\" = 1 ]"
  run_heal   # 第2次达阈值 → restart
  check "进程死触发 restart" "[ \"\$(cat $T/bin/calls.env 2>/dev/null || echo RESTART_CALLS=0)\" = 'RESTART_CALLS=1' ]"
  check "restart 后 fails 归 0" "[ \"$(state_fails)\" = 0 ]"

  # === 场景 3: WS 断连(无 botName) → restart ===
  reset_round
  OMP_OK=1 RESTART_OK=1 RESTART_FIX=1
  printf '{"entries":[{"pid":123}]}' > "$T/state/processes.json"
  start_proc
  run_heal; run_heal
  check "断连触发 restart" "[ \"\$(cat $T/bin/calls.env 2>/dev/null || echo RESTART_CALLS=0)\" = 'RESTART_CALLS=1' ]"
  stop_proc

  # === 场景 4: omp 不可用 → 判异常 ===
  reset_round
  OMP_OK=0 RESTART_OK=1 RESTART_FIX=1
  printf '{"entries":[{"botName":"Agent","pid":123}]}' > "$T/state/processes.json"
  start_proc
  run_heal
  check "omp 不可用计入异常 fails>=1" "[ \"$(state_fails)\" -ge 1 ]"
  stop_proc

  # === 场景 5: restart 失败 → 唤起 omp ===
  reset_round
  OMP_OK=1 OMP_RUN_OK=1 RESTART_OK=0 RESTART_FIX=0
  printf '{"entries":[{"pid":123}]}' > "$T/state/processes.json"
  run_heal; run_heal
  check "restart 失败后唤起 omp" "[ -f $T/omp/calls.log ]"
  OMP_RUN_OK=0 RESTART_OK=1

  # === 场景 6: 锁互斥 ===
  reset_round
  OMP_OK=1 RESTART_OK=1 RESTART_FIX=1
  printf '{"entries":[{"botName":"Agent","pid":123}]}' > "$T/state/processes.json"
  start_proc
  mkdir -p "$T/heal.lock.d"
  run_heal
  check "锁冲突时跳过执行" "[ ! -f $T/bin/calls.env ]"
  stop_proc

  # === 场景 7: omp 修复阶梯退避 ===
  reset_round
  OMP_OK=1 OMP_RUN_OK=0 RESTART_OK=0 RESTART_FIX=0
  HEAL_BACKOFF_BASE_S=600   # 非零退避：失败后必被 nextOmpAt 挡住
  printf '{"entries":[{"pid":123}]}' > "$T/state/processes.json"
  # 第1轮达阈值 → restart 失败 → 唤起 omp → omp 失败 → 设退避
  run_heal; run_heal
  check "omp 失败后设退避(nextOmpAt>0)" "[ \"\$(python3 -c \"import json;print(json.load(open('$T/state/heal-state.json')).get('nextOmpAt',0))\")\" -gt 0 ]"
  # 立即再跑：退避应挡住不再唤起 omp（calls.log 行数不变）
  OMP_RUN_CALLS_BEFORE="$(wc -l < "$T/omp/calls.log" 2>/dev/null || echo 0)"
  run_heal; run_heal
  OMP_RUN_CALLS_AFTER="$(wc -l < "$T/omp/calls.log" 2>/dev/null || echo 0)"
  check "退避期间不再唤起 omp" "[ \"$OMP_RUN_CALLS_AFTER\" = \"$OMP_RUN_CALLS_BEFORE\" ]"

  # === 场景 8: omp 并发锁 ===
  reset_round
  OMP_OK=1 OMP_RUN_OK=0 RESTART_OK=0 RESTART_FIX=0
  HEAL_BACKOFF_BASE_S=0
  printf '{"entries":[{"pid":123}]}' > "$T/state/processes.json"
  rm -f "$T/omp/calls.env"
  mkdir -p "$T/heal.lock.omp.d"   # 预占 omp 修复锁
  run_heal; run_heal
  check "omp 锁被占时跳过唤起" "[ ! -f $T/omp/calls.env ]"

  # === 场景 9: omp 修复成功闭环 ===
  reset_round
  OMP_OK=1 OMP_RUN_OK=1 RESTART_OK=0 RESTART_FIX=1
  printf '{"entries":[{"pid":123}]}' > "$T/state/processes.json"
  start_proc   # 进程必须在，omp 修复复查时 probe 才能通过
  run_heal; run_heal
  check "omp 修复后自愈完成(fails=0)" "[ \"$(state_fails)\" = 0 ]"
  check "omp 修复后 ompAttempts 重置" "[ \"\$(python3 -c \"import json;print(json.load(open('$T/state/heal-state.json')).get('ompAttempts',-1))\")\" = 0 ]"
  stop_proc

  # === 场景 10: 达到最大修复次数 → 停止唤起 omp ===
  reset_round
  OMP_OK=1 OMP_RUN_OK=0 RESTART_OK=0 RESTART_FIX=0
  HEAL_MAX_ATTEMPTS=2
  HEAL_BACKOFF_BASE_S=0
  printf '{"entries":[{"pid":123}]}' > "$T/state/processes.json"
  # 前 2 次达阈值 → 唤起 omp 并失败 → ompAttempts=2（已达上限）
  run_heal; run_heal; run_heal; run_heal
  check "达到上限后 ompAttempts=2" "[ \"\$(python3 -c \"import json;print(json.load(open('$T/state/heal-state.json')).get('ompAttempts',-1))\")\" = 2 ]"
  # 记录当前 run 次数，再跑一轮确认不再唤起
  local_before="$(wc -l < "$T/omp/calls.log" 2>/dev/null || echo 0)"
  run_heal; run_heal
  local_after="$(wc -l < "$T/omp/calls.log" 2>/dev/null || echo 0)"
  check "达到上限后不再唤起 omp" "[ \"$local_after\" = \"$local_before\" ]"

  # === 场景 11: 修复提示词契约（进入修复/修复后启动/退出 AI 指令都在） ===
  reset_round
  OMP_OK=1 OMP_RUN_OK=0 RESTART_OK=0 RESTART_FIX=0
  HEAL_BACKOFF_BASE_S=0
  printf '{"entries":[{"pid":123}]}' > "$T/state/processes.json"
  rm -f "$T/omp/last-ctx.txt"
  run_heal; run_heal
  check "提示词被传给 omp" "[ -f $T/omp/last-ctx.txt ]"
  check "含诊断步骤(进入修复)" "grep -q '诊断' $T/omp/last-ctx.txt"
  check "含修复步骤" "grep -q '修复' $T/omp/last-ctx.txt"
  check "含启动命令(restart+status)" "grep -q 'restart' $T/omp/last-ctx.txt && grep -q 'status' $T/omp/last-ctx.txt"
  check "含成功标准(在线)" "grep -q '在线' $T/omp/last-ctx.txt"
  check "含退出约束(立即停止/结束)" "grep -q '停止' $T/omp/last-ctx.txt"
  check "含禁止无关工作约束" "grep -q '无关' $T/omp/last-ctx.txt"
done

echo ""
if [ "$FAILS" -eq 0 ]; then
  echo "✅ 全部 ${TOTAL} 次执行断言通过（$ROUNDS 轮）"
  exit 0
else
  echo "❌ ${FAILS} 项断言失败（共 ${TOTAL} 次执行）"
  exit 1
fi
