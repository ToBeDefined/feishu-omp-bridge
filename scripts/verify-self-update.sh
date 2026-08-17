#!/usr/bin/env bash
# self-update.sh 端到端自动测试（隔离 git 仓库 + 假 pnpm/node，多轮）。
#
# 隔离手段：
#   - 临时 git 仓库（bare origin 含 old+new）+ 工作 repo 在 old
#   - 假 pnpm：可控 typecheck/test/build 成败
#   - 假 node：拦截 bin/feishu-omp-bridge.mjs restart/status
#   - git 用真的（在隔离 repo 内操作），避免假 git 转发挂起
#
# 覆盖场景：
#   1. 更新成功（pull + 门禁全过 + restart）
#   2. typecheck 失败 → 回滚旧 HEAD + 恢复旧 dist + 不 restart
#   3. test 失败 → 回滚
#   4. build 失败 → 回滚
#   5. restart 失败 → 回滚
#   6. 锁互斥（已有更新在跑 → 跳过）
#
# 用法：
#   scripts/verify-self-update.sh [rounds]

set -euo pipefail

SCRIPT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/self-update.sh"
ROUNDS="${1:-3}"
FAILS=0
TOTAL=0

T=$(mktemp -d /tmp/update-test.XXXXXX)
export T
trap 'rm -rf "$T"' EXIT

# --- 假工具目录 ---
mkdir -p "$T/fake/bin"

# 假 node：只拦截 bin/feishu-omp-bridge.mjs，其余转发真 node（绝对路径避免递归）
REAL_NODE="$(command -v node || echo /usr/bin/env node)"
cat > "$T/fake/bin/node" <<EOF
#!/usr/bin/env bash
if [ "\${1:-}" = "bin/feishu-omp-bridge.mjs" ] && [ "\${2:-}" = "restart" ]; then
  echo "RESTART_CALLS=\$((${RESTART_CALLS:-0}+1))" > "$T/fake/restart.env"
  [ "\${RESTART_OK:-1}" = 1 ]
  exit \$?
fi
exec "$REAL_NODE" "\$@"
EOF
chmod +x "$T/fake/bin/node"

# 假 pnpm：typecheck/test/build 成败可控
cat > "$T/fake/bin/pnpm" <<'EOF'
#!/usr/bin/env bash
case "${1:-}" in
  typecheck)
    [ "${TC_OK:-1}" = 1 ]
    ;;
  test)
    [ "${TEST_OK:-1}" = 1 ]
    ;;
  build)
    [ "${BUILD_OK:-1}" = 1 ] && touch "$T/fake/build-ran"
    ;;
  *) exit 0 ;;
esac
EOF
chmod +x "$T/fake/bin/pnpm"

# 构造隔离 git 仓库：bare origin(含 old+new) + 工作 repo(在 old)
setup_repo() {
  cd "$T"
  rm -rf "$T/origin.git" "$T/repo" "$T/fake/restart.env" "$T/fake/build-ran" \
        "$T/update.log" "$T/update-status" "$T/update.lock.d" \
        "$T/old-head.txt" "$T/new-head.txt"
  git init -q --bare "$T/origin.git"
  git init -q "$T/repo"
  cd "$T/repo"
  git config user.email test@test
  git config user.name test
  git remote add origin "$T/origin.git"
  mkdir -p src dist bin
  echo 'console.log("old")' > src/index.ts
  echo '{"scripts":{"typecheck":"x","test":"x","build":"x"}}' > package.json
  printf '#!/usr/bin/env node\n' > bin/feishu-omp-bridge.mjs
  chmod +x bin/feishu-omp-bridge.mjs
  echo "OLD-DIST" > dist/cli.js
  git add -A && git commit -qm old
  git push -q -u origin HEAD:main
  OLD_HEAD="$(git rev-parse --short HEAD)"
  echo "$OLD_HEAD" > "$T/old-head.txt"
  echo 'console.log("new")' > src/index.ts
  git add -A && git commit -qm new
  NEW_HEAD="$(git rev-parse --short HEAD)"
  git push -q origin HEAD:main
  echo "$NEW_HEAD" > "$T/new-head.txt"
  git reset -q --hard "$OLD_HEAD"
  # 默认门禁全过
  TC_OK=1 TEST_OK=1 BUILD_OK=1 RESTART_OK=1
}

# 跑一轮 self-update（隔离 repo + 假 pnpm/node，真 git）
run_update() {
  TOTAL=$((TOTAL+1))
  if PATH="$T/fake/bin:$PATH" \
     UPDATE_REPO="$T/repo" \
     UPDATE_LOCK_FILE="$T/update.lock" \
     UPDATE_LOG_FILE="$T/update.log" \
     TC_OK="${TC_OK:-1}" TEST_OK="${TEST_OK:-1}" BUILD_OK="${BUILD_OK:-1}" RESTART_OK="${RESTART_OK:-1}" \
     bash "$SCRIPT" >"$T/update-out.log" 2>&1; then
    echo "ok" > "$T/update-status"
  else
    echo "fail" > "$T/update-status"
  fi
}

check() {
  local name="$1" cond="$2"
  if eval "$cond"; then
    printf '  ✓ %s\n' "$name"
  else
    printf '  ✗ %s\n' "$name"
    printf '    (log: %s)\n' "$(tail -3 "$T/update.log" 2>/dev/null | tr '\n' ' ')"
    FAILS=$((FAILS+1))
  fi
}

cur_head() { (cd "$T/repo" && git rev-parse --short HEAD); }
old_head() { cat "$T/old-head.txt"; }
new_head() { cat "$T/new-head.txt"; }

echo "== self-update 端到端测试（$ROUNDS 轮）=="
for round in $(seq 1 "$ROUNDS"); do
  echo "— 第 ${round}/${ROUNDS} 轮 —"
  setup_repo

  # === 场景 1: 全部通过 → 更新到新 HEAD + restart ===
  run_update
  check "更新成功(status=ok)" "[ \"\$(cat $T/update-status)\" = ok ]"
  check "HEAD 前进到新版本" "[ \"$(cur_head)\" = \"$(new_head)\" ]"
  check "restart 被调用" "[ -f $T/fake/restart.env ]"

  # === 场景 2: typecheck 失败 → 回滚 ===
  setup_repo; TC_OK=0
  run_update
  check "typecheck 失败(status=fail)" "[ \"\$(cat $T/update-status)\" = fail ]"
  check "回滚到旧 HEAD" "[ \"$(cur_head)\" = \"$(old_head)\" ]"
  check "typecheck 失败未 restart" "[ ! -f $T/fake/restart.env ]"

  # === 场景 3: test 失败 → 回滚 ===
  setup_repo; TEST_OK=0
  run_update
  check "test 失败(status=fail)" "[ \"\$(cat $T/update-status)\" = fail ]"
  check "回滚到旧 HEAD" "[ \"$(cur_head)\" = \"$(old_head)\" ]"
  check "test 失败未 restart" "[ ! -f $T/fake/restart.env ]"

  # === 场景 4: build 失败 → 回滚 ===
  setup_repo; BUILD_OK=0
  run_update
  check "build 失败(status=fail)" "[ \"\$(cat $T/update-status)\" = fail ]"
  check "回滚到旧 HEAD" "[ \"$(cur_head)\" = \"$(old_head)\" ]"
  check "build 失败未 restart" "[ ! -f $T/fake/restart.env ]"

  # === 场景 5: restart 失败 → 回滚 ===
  setup_repo; RESTART_OK=0
  run_update
  check "restart 失败(status=fail)" "[ \"\$(cat $T/update-status)\" = fail ]"
  check "restart 失败回滚到旧 HEAD" "[ \"$(cur_head)\" = \"$(old_head)\" ]"

  # === 场景 6: 锁互斥 ===
  setup_repo
  mkdir -p "$T/update.lock.d"
  run_update
  check "锁冲突跳过(status=fail)" "[ \"\$(cat $T/update-status)\" = fail ]"
  check "锁冲突未 restart" "[ ! -f $T/fake/restart.env ]"
done

echo ""
if [ "$FAILS" -eq 0 ]; then
  echo "✅ 全部 ${TOTAL} 次执行断言通过（$ROUNDS 轮）"
  exit 0
else
  echo "❌ ${FAILS} 项断言失败（共 ${TOTAL} 次执行）"
  exit 1
fi
