#!/usr/bin/env python3
"""受控自更新：git pull → typecheck → build → test → 全过才 restart。

任一步失败 → 回滚代码 + 恢复备份的 dist → 不重启，保持旧版本运行。

用法：
  self-update.py                # 从 origin/main 更新
  self-update.py <branch|tag>   # 从指定分支/标签更新

设计要点（与原 self-update.sh 等价）：
  - 原子锁互斥，避免并发触发两次更新。
  - dist/ 先备份，build 失败可立即还原。
  - 回滚用 git reset --hard 回到旧 HEAD，不碰 untracked；未提交改动先 stash。

环境变量（测试注入点）：
  UPDATE_REPO / UPDATE_LOCK_FILE / UPDATE_LOG_FILE / UPDATE_GATES(JSON)
"""

import json
import os
import shutil
import fcntl
import subprocess
import sys
import time
from typing import Optional
from datetime import datetime
from pathlib import Path


REPO = os.environ.get("UPDATE_REPO", str(Path(__file__).resolve().parent.parent))
BRANCH = sys.argv[1] if len(sys.argv) > 1 else ""
LOCK_FILE = os.environ.get("UPDATE_LOCK_FILE", os.path.join(os.environ.get("TMPDIR", "/tmp"), "feishu-omp-bridge-self-update.lock"))
LOG_FILE = os.environ.get("UPDATE_LOG_FILE", os.path.join(os.environ.get("TMPDIR", "/tmp"), "feishu-omp-bridge-self-update.log"))


def log(msg: str) -> None:
    line = f"[{datetime.now().strftime('%Y-%m-%d %H:%M:%S')}] {msg}"
    print(line, flush=True)
    try:
        Path(LOG_FILE).parent.mkdir(parents=True, exist_ok=True)
        with open(LOG_FILE, "a", encoding="utf-8") as f:
            f.write(line + "\n")
    except OSError:
        pass


def run(cmd: list[str], **kw) -> subprocess.CompletedProcess:
    """Run a command, capturing output. Never raises (returncode on failure)."""
    try:
        return subprocess.run(cmd, capture_output=True, text=True, timeout=kw.get("timeout", 600), cwd=kw.get("cwd", REPO))
    except (subprocess.SubprocessError, FileNotFoundError) as e:
        r = subprocess.CompletedProcess(cmd, 1)
        r.stderr = str(e)
        return r


def git(*args: str) -> subprocess.CompletedProcess:
    return run(["git", *args])


def short_head() -> str:
    return git("rev-parse", "--short", "HEAD").stdout.strip() or "unknown"


def _acquire_lock() -> Optional[int]:
    """fcntl 文件锁（进程被 SIGKILL/SIGTERM 强杀时内核自动释放）。
    之前的 mkdir 原子锁在强杀下目录永久残留，之后所有自更新永远被拒。"""
    try:
        fd = os.open(LOCK_FILE, os.O_CREAT | os.O_RDWR, 0o644)
        fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
        return fd
    except OSError:
        return None


def main() -> int:
    fd = _acquire_lock()
    if fd is None:
        log("✗ 已有自更新在运行，跳过。")
        return 2
    try:
        return update()
    finally:
        try:
            fcntl.flock(fd, fcntl.LOCK_UN)
        finally:
            os.close(fd)


def update() -> int:
    os.chdir(REPO)
    old_head = git("rev-parse", "HEAD").stdout.strip()
    orig_branch = git("rev-parse", "--abbrev-ref", "HEAD").stdout.strip()
    log(f"当前 HEAD: {old_head[:12]}（{orig_branch}）")

    # 未提交改动（排除 dist）→ stash
    dirty = False
    diff = git("diff", "--quiet", "--", ":!dist")
    if diff.returncode != 0:
        dirty = True
        log("检测到未提交改动，先 stash 以便回滚。")
        git("stash", "push", "-m", f"self-update pre-update state {datetime.now().strftime('%Y-%m-%d %H:%M:%S')}", "--", ":!dist")

    # 备份 dist（目录名用纳秒时间戳，确保唯一，防并发/同秒冲突）
    dist_backup = os.path.join(
        os.environ.get("TMPDIR", "/tmp"),
        f"feishu-omp-bridge-dist-{time.time_ns()}",
    )
    if Path("dist").is_dir():
        shutil.copytree("dist", dist_backup)
        log(f"已备份 dist → {dist_backup}")

    def rollback() -> None:
        log(f"→ 回滚到 {old_head[:12]}")
        # 先切回原分支再 reset：BRANCH 模式失败时若停在目标分支上直接 reset，
        # 会把目标分支的 ref 拽回旧提交、破坏该分支。
        if orig_branch and orig_branch != "HEAD" and git("rev-parse", "--abbrev-ref", "HEAD").stdout.strip() != orig_branch:
            git("checkout", "-q", orig_branch)
        git("reset", "--hard", old_head)
        if dirty:
            git("stash", "pop")
        if Path(dist_backup).is_dir():
            shutil.rmtree("dist", ignore_errors=True)
            shutil.move(dist_backup, "dist")
            log("已还原旧 dist")
        st = run(["node", "bin/feishu-omp-bridge.mjs", "status"])
        if st.returncode == 0:
            log("daemon 仍在运行（旧版本）")
        else:
            log("daemon 当前未运行（旧版本可手动 start）")

    # --- 拉取 ---
    if BRANCH:
        log(f"拉取 {BRANCH} ...")
        if not (git("fetch", "origin").returncode == 0 and git("checkout", BRANCH).returncode == 0
                and git("pull", "--ff-only", "origin", BRANCH).returncode == 0):
            log("✗ git 拉取失败，回滚。")
            rollback()
            return 1
    else:
        log("拉取 origin/main ...")
        if git("pull", "--ff-only", "origin", "main").returncode != 0:
            log("✗ git pull 失败，回滚。")
            rollback()
            return 1

    new_head = git("rev-parse", "HEAD").stdout.strip()
    log(f"新 HEAD: {new_head[:12]}")

    # --- 门禁：typecheck + test + build 全过才生效 ---
    # 测试注入：UPDATE_GATES JSON 可覆盖每个门禁结果（如 {"typecheck":false}）
    gates = {}
    try:
        gates = json.loads(os.environ.get("UPDATE_GATES", "{}"))
    except json.JSONDecodeError:
        pass

    def gate(name: str, cmd: list[str]) -> bool:
        if name in gates:
            return bool(gates[name])
        return run(cmd).returncode == 0

    if not gate("typecheck", ["pnpm", "typecheck"]):
        log("✗ typecheck 失败，回滚。")
        rollback()
        return 1
    log("✓ typecheck 通过")

    if not gate("test", ["pnpm", "test"]):
        log("✗ 测试失败，回滚。")
        rollback()
        return 1
    log("✓ 测试通过")

    if not gate("build", ["pnpm", "build"]):
        log("✗ build 失败，回滚。")
        rollback()
        return 1
    log("✓ build 通过")

    # --- 全部通过，重启 daemon ---
    log("重启 daemon...")
    if run(["node", "bin/feishu-omp-bridge.mjs", "restart"]).returncode != 0:
        log("✗ restart 失败，回滚到旧版本。")
        rollback()
        return 1

    log(f"✓ 自更新完成：{old_head[:12]} → {new_head[:12]}")
    # 成功路径同样恢复 pre-update stash（此前静默留在 stash 里，用户未提交
    # 的改动被遗忘）。pop 冲突时保留 stash 并提示，绝不丢数据。
    if dirty:
        pop = git("stash", "pop")
        if pop.returncode == 0:
            log("✓ 已恢复更新前的未提交改动（stash pop）")
        else:
            log("⚠ stash pop 有冲突，未提交改动保留在 stash 中，请手动 git stash pop 处理。")
    return 0


if __name__ == "__main__":
    sys.exit(main())
