#!/usr/bin/env bash
# 受控自更新：git pull → typecheck → build → test → 全过才 restart。
# 任一步失败 → 回滚代码 + 恢复备份的 dist → 不重启，保持旧版本运行。
#
# 用法：
#   scripts/self-update.sh                # 从 origin/main 更新
#   scripts/self-update.sh <branch|tag>   # 从指定分支/标签更新
#
# 设计要点：
#   - 单进程互斥（flock），避免 agent 并发触发两次更新。
#   - dist/ 先备份，build 失败可立即还原，bridge 无需重启。
#   - 全程不回滚用户未提交的工作区改动（只动 git pull 影响的范围，
#     失败时用 git reset --hard 回到更新前的 HEAD，不碰 untracked）。
#   - 输出每步结果到 stdout，由调用方（agent / 手动）决定如何通知。

set -euo pipefail

REPO="${UPDATE_REPO:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}"
BRANCH="${1:-}"
LOCK_FILE="${UPDATE_LOCK_FILE:-${TMPDIR:-/tmp}/feishu-omp-bridge-self-update.lock}"
LOG_FILE="${UPDATE_LOG_FILE:-${TMPDIR:-/tmp}/feishu-omp-bridge-self-update.log}"

# 日志：同时写文件，失败时整段带回给调用方。
log() { echo "[$(date '+%F %T')] $*" | tee -a "$LOG_FILE"; }

# Portable mutual exclusion (macOS has no flock(1)): atomic mkdir lock.
LOCK_DIR="${LOCK_FILE}.d"
if ! mkdir "$LOCK_DIR" 2>/dev/null; then
  log "✗ 已有自更新在运行，跳过。"
  exit 2
fi
trap 'rmdir "$LOCK_DIR" 2>/dev/null || true' EXIT

cd "$REPO"

# 需要带 untracked（dist/ 未提交）做干净回滚点。
OLD_HEAD="$(git rev-parse HEAD)"
STASH_MSG="self-update pre-update state $(date '+%F %T')"

log "当前 HEAD: ${OLD_HEAD:0:12}"

# 记录是否有未提交改动；有则先 stash（restore 时恢复）。
DIRTY=0
if ! git diff --quiet -- ':!dist'; then
  DIRTY=1
  log "检测到未提交改动，先 stash 以便回滚。"
  git stash push -m "$STASH_MSG" -- ':!dist' || true
fi

# 备份当前 dist（build 后内容可能不可用，备份的是"旧可用"版本）。
DIST_BACKUP="${TMPDIR:-/tmp}/feishu-omp-bridge-dist-$(date +%s)"
if [ -d dist ]; then
  cp -R dist "$DIST_BACKUP"
  log "已备份 dist → $DIST_BACKUP"
fi

rollback() {
  log "→ 回滚到 ${OLD_HEAD:0:12}"
  git reset --hard "$OLD_HEAD" 2>/dev/null || true
  # 恢复工作区未提交改动
  if [ "$DIRTY" = 1 ]; then
    git stash pop 2>/dev/null || true
  fi
  # 恢复旧 dist
  if [ -d "$DIST_BACKUP" ]; then
    rm -rf dist
    mv "$DIST_BACKUP" dist
    log "已还原旧 dist"
  fi
  # 确保 daemon 仍指向可用构建
  node bin/feishu-omp-bridge.mjs status >/dev/null 2>&1 \
    && log "daemon 仍在运行（旧版本）" \
    || log "daemon 当前未运行（旧版本可手动 start）"
}

# --- 拉取 ---
if [ -n "$BRANCH" ]; then
  log "拉取 $BRANCH ..."
  if ! git fetch origin && git checkout "$BRANCH" && git pull --ff-only origin "$BRANCH"; then
    log "✗ git 拉取失败，回滚。"
    rollback; exit 1
  fi
else
  log "拉取 origin/main ..."
  if ! git pull --ff-only origin main; then
    log "✗ git pull 失败，回滚。"
    rollback; exit 1
  fi
fi

NEW_HEAD="$(git rev-parse HEAD)"
log "新 HEAD: ${NEW_HEAD:0:12}"

# --- 门禁：typecheck + test + build 全部通过才生效 ---
if ! pnpm typecheck >/dev/null 2>&1; then
  log "✗ typecheck 失败，回滚。"
  rollback; exit 1
fi
log "✓ typecheck 通过"

if ! pnpm test >/dev/null 2>&1; then
  log "✗ 测试失败，回滚。"
  rollback; exit 1
fi
log "✓ 测试通过"

if ! pnpm build >/dev/null 2>&1; then
  log "✗ build 失败，回滚。"
  rollback; exit 1
fi
log "✓ build 通过"

# --- 全部通过，重启 daemon 加载新构建 ---
log "重启 daemon..."
if ! node bin/feishu-omp-bridge.mjs restart; then
  log "✗ restart 失败，回滚到旧版本。"
  rollback
  exit 1
fi

log "✓ 自更新完成：${OLD_HEAD:0:12} → ${NEW_HEAD:0:12}"
