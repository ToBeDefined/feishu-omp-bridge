#!/usr/bin/env python3
"""自愈看门狗：定期健康探测 bridge daemon，异常时自动修复。

功能等价于原 self-heal.sh（Python 重写，接口一致）：

  探测维度（每 60s，连续 FAIL_THRESHOLD 次异常才算"假死"）：
    1. 进程存活  —— launchd 给的 pid / processes.json 里进程自写的 pid
                    (kill -0) / pgrep 命中，三路独立信号取 OR；只有三路都
                    判死才算死，探针超时/异常一律算"判不出"，绝不当成死。
    2. 服务连通  —— bridge status 显示正在后台运行
  探测结果是三态：True 健康 / False 确认假死 / None 判不出。只有 False 才
  会触发修复动作 —— 对"可能是健康的"daemon 做破坏性 restart/回退，代价远
  高于多等一轮。OMP 是 bridge 的外部依赖；它不可用时由具体 agent 请求报告
  错误，不能反过来把在线 bridge 判成假死并触发破坏性重启或回滚。

  修复策略（由轻到重）：
    A. bridge restart（每轮阈值都试，轻量）
    B. omp run 修复会话（并发锁 + 阶梯退避 + 最大次数上限 + 提示词退出契约）

用法：
  self-heal.py            # 常驻循环（launchd KeepAlive 拉起）
  self-heal.py --once     # 只探测一轮
  self-heal.py --repair   # 独立唤起 omp 修复（service.ts SELF_HEAL=1 用）
  self-heal.py install    # 注册 launchd watchdog
  self-heal.py uninstall

环境变量（测试注入点）：
  HEAL_STATE_DIR / HEAL_LOCK_FILE / HEAL_RESTART_CMD / HEAL_OMP_BIN /
  HEAL_PGREP_PATTERN / HEAL_RECOVER_WAIT_S / HEAL_INTERVAL_S /
  HEAL_FAIL_THRESHOLD / HEAL_OMP_TIMEOUT_S / HEAL_MODEL /
  HEAL_BACKOFF_BASE_S / HEAL_BACKOFF_MAX_S / HEAL_MAX_ATTEMPTS /
  HEAL_PROC_TIMEOUT_S / HEAL_WS_TIMEOUT_S / HEAL_BUILD_TIMEOUT_S /
  HEAL_ROLLBACK
"""

from __future__ import annotations

import json
import os
import re
import shutil
import subprocess
import sys
import time
from datetime import datetime
from pathlib import Path

# --- 配置（环境变量可覆盖，测试注入点） ---
REPO = os.environ.get("HEAL_REPO", str(Path(__file__).resolve().parent.parent))
STATE_DIR = os.environ.get("HEAL_STATE_DIR", os.path.join(os.path.expanduser("~"), ".feishu-omp-bridge"))
STATE_FILE = os.path.join(STATE_DIR, "heal-state.json")
LOCK_FILE = os.environ.get("HEAL_LOCK_FILE", os.path.join(os.environ.get("TMPDIR", "/tmp"), "feishu-omp-bridge-self-heal.lock"))
LOG_FILE = os.environ.get("HEAL_LOG_FILE", os.path.join(STATE_DIR, "logs", "heal.log"))
RESTART_CMD = os.environ.get("HEAL_RESTART_CMD", f"node {REPO}/bin/feishu-omp-bridge.mjs")
OMP_BIN = os.environ.get("HEAL_OMP_BIN", "omp")
PGREP_PATTERN = os.environ.get("HEAL_PGREP_PATTERN", "feishu-omp-bridge.mjs run")
RECOVER_WAIT_S = int(os.environ.get("HEAL_RECOVER_WAIT_S", "5"))

# 探针超时：旧值 pgrep 5s / status 15s 太紧 —— 系统忙时探针自己会超时，
# 而超时被当成"进程不存在"，就会对健康的 daemon 动手（2026-09-24 重启风暴）。
PROC_TIMEOUT_S = int(os.environ.get("HEAL_PROC_TIMEOUT_S", "15"))
WS_TIMEOUT_S = int(os.environ.get("HEAL_WS_TIMEOUT_S", "30"))
# pnpm build 超时：旧值 120s 会在机器忙时超时，把回退留在半途（dist 与
# 回退后的 src 漂移）。超时按"环境问题"处理，不作为"代码坏"的证据。
BUILD_TIMEOUT_S = int(os.environ.get("HEAL_BUILD_TIMEOUT_S", "300"))

INTERVAL_S = int(os.environ.get("HEAL_INTERVAL_S", "60"))
FAIL_THRESHOLD = int(os.environ.get("HEAL_FAIL_THRESHOLD", "3"))
OMP_TIMEOUT_S = int(os.environ.get("HEAL_OMP_TIMEOUT_S", "300"))
HEAL_MODEL = os.environ.get("HEAL_MODEL", "zhipu-coding-plan/glm-5.2")
BACKOFF_BASE_S = int(os.environ.get("HEAL_BACKOFF_BASE_S", "60"))
BACKOFF_MAX_S = int(os.environ.get("HEAL_BACKOFF_MAX_S", "480"))
MAX_ATTEMPTS = int(os.environ.get("HEAL_MAX_ATTEMPTS", "10"))
# 回退退避：每次回退尝试之间的阶梯间隔，防对暂时性故障连续过激回退。
ROLLBACK_BASE_S = int(os.environ.get("HEAL_ROLLBACK_BASE_S", "60"))
ROLLBACK_MAX_S = int(os.environ.get("HEAL_ROLLBACK_MAX_S", "480"))
# 逐节点回退最多退几步，超过交给 omp（防止一路退到 root）。
MAX_ROLLBACK_STEPS = int(os.environ.get("HEAL_MAX_ROLLBACK_STEPS", "10"))

SERVICE_LABEL = "ai.feishu-omp-bridge.heal"


def log(msg: str) -> None:
    line = f"[{datetime.now().strftime('%Y-%m-%d %H:%M:%S')}] {msg}"
    print(line, flush=True)
    try:
        Path(LOG_FILE).parent.mkdir(parents=True, exist_ok=True)
        with open(LOG_FILE, "a", encoding="utf-8") as f:
            f.write(line + "\n")
    except OSError:
        pass


# --- 互斥锁（fcntl 文件锁，进程退出时内核自动释放） ---
# 相比 mkdir 原子锁：进程被 kill -9 / SIGTERM 强杀时，OS 自动释放文件锁，
# 不会残留脏锁导致 watchdog 永远无法启动。这是自愈工具的关键可靠性点。
class DirLock:
    def __init__(self, path: str):
        self.path = path
        self._fd: int | None = None

    def acquire(self) -> bool:
        try:
            fd = os.open(self.path, os.O_CREAT | os.O_RDWR, 0o600)
        except OSError:
            return False
        try:
            import fcntl

            fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except (ImportError, OSError):
            os.close(fd)
            return False
        self._fd = fd
        return True

    def release(self) -> None:
        if self._fd is not None:
            try:
                import fcntl

                fcntl.flock(self._fd, fcntl.LOCK_UN)
            except (ImportError, OSError):
                pass
            os.close(self._fd)
            self._fd = None


def _read_state() -> dict:
    try:
        with open(STATE_FILE, encoding="utf-8") as f:
            data = json.load(f)
            return data if isinstance(data, dict) else {}
    except (OSError, json.JSONDecodeError):
        return {}


def _write_state(updates: dict) -> None:
    data = _read_state()
    data.update(updates)
    Path(STATE_FILE).parent.mkdir(parents=True, exist_ok=True)
    with open(STATE_FILE, "w", encoding="utf-8") as f:
        json.dump(data, f)


def state_get(key: str) -> int:
    return int(_read_state().get(key, 0))


def _now_iso() -> str:
    return datetime.now().strftime("%Y-%m-%dT%H:%M:%S")


def write_fails(fails: int) -> None:
    _write_state({"fails": fails, "lastCheck": _now_iso()})


# --- 健康探测 ---
def _registered_pid() -> int | None:
    """processes.json 里登记的 daemon pid（取第一个可解析的条目）。

    这是 bridge 进程自己写的"我在跑，pid=N"，与 pgrep 的 argv 模式匹配
    完全独立：pgrep 会因为入口路径不同（argv 不含 feishu-omp-bridge.mjs）
    或超时假阴性，而 pid + kill -0 不会。"""
    try:
        with open(os.path.join(STATE_DIR, "processes.json"), encoding="utf-8") as f:
            data = json.load(f)
    except (OSError, json.JSONDecodeError):
        return None
    entries = data.get("entries") if isinstance(data, dict) else None
    if not isinstance(entries, list):
        return None
    for entry in entries:
        if not isinstance(entry, dict):
            continue
        try:
            pid = int(entry.get("pid"))
        except (TypeError, ValueError):
            continue
        if pid > 0:
            return pid
    return None


def _pid_alive(pid: int) -> bool:
    """kill(pid, 0)：能发信号即活着。PermissionError 说明进程存在（只是不
    归我们管），同样算活着。"""
    try:
        os.kill(pid, 0)
    except ProcessLookupError:
        return False
    except PermissionError:
        return True
    except OSError:
        return False
    return True


def _pgrep_alive() -> bool | None:
    """pgrep 模式匹配。True/False 是明确结论，None = 判不出（超时 / pgrep
    缺失）—— "慢"不等于"死"。"""
    try:
        out = subprocess.run(
            ["pgrep", "-f", PGREP_PATTERN],
            capture_output=True, text=True, timeout=PROC_TIMEOUT_S,
        )
    except (subprocess.SubprocessError, FileNotFoundError):
        return None
    if out.returncode == 0:
        return True
    if out.returncode == 1:
        return False
    return None


def _service_status() -> tuple[bool | None, int | None]:
    """跑一次 `bridge status`，返回 (是否在后台运行, launchd 记录的 pid)。

    进程 pid 由 launchd 自己给出（`bridge status` 里的「进程 ID: N」），
    与 argv 形态无关，是比 pgrep 更权威的存活证据。命令跑不起来/超时 →
    (None, None)：状态未知，不能当成"没在跑"。"""
    try:
        r = subprocess.run(
            [*RESTART_CMD.split(), "status"],
            capture_output=True, text=True, timeout=WS_TIMEOUT_S,
        )
    except (subprocess.SubprocessError, FileNotFoundError, IndexError):
        return None, None
    stdout = r.stdout or ""
    pid: int | None = None
    m = re.search(r"进程 ID:\s*(\d+)", stdout)
    if m:
        pid = int(m.group(1))
    return (r.returncode == 0 and "正在后台运行" in stdout), pid


def _proc_alive(launchd_pid: int | None = None) -> bool | None:
    """进程存活：三路独立信号取 OR，只有全部判死才返回 False。

    1. launchd 自己的 pid（最权威，与 argv 无关）
    2. processes.json 里进程自写的 pid
    3. pgrep -f 模式匹配（受入口路径与超时影响，最弱）
    任一确认活着 → True；判死必须是 pgrep 明确无匹配（rc=1）；pgrep 判不出
    且两处 pid 都不可用/已死 → None（判不出，交给下一轮）。"""
    for pid in (launchd_pid, _registered_pid()):
        if pid is not None and _pid_alive(pid):
            return True
    pg = _pgrep_alive()
    if pg is None and launchd_pid is None:
        return None
    return pg


def probe() -> bool | None:
    """True=健康；False=确认假死（可以动手修）；None=判不出（不动手）。

    判死门槛：进程存活检查确认无进程（三路信号一致判死），或 `bridge
    status` 明确报"没在后台运行"。任一探针超时/无法执行 → None：宁可多等
    一轮，也不对可能是健康的 daemon 做破坏性 restart / git 回退。"""
    running, launchd_pid = _service_status()
    alive = _proc_alive(launchd_pid)
    if alive is None:
        log("✗ 进程探针判不出（pgrep 超时/异常，且无可用 pid），本轮不动手")
        return None
    if alive:
        if running:
            return True
        if running is None:
            log("✗ 服务探针判不出（bridge status 超时/异常），本轮不动手")
            return None
        log("✗ 未检测到 WS 连接(bridge status 报告未在后台运行)")
        return False
    log("✗ 进程不存在(launchd pid / 注册表 pid / pgrep 均未发现进程)")
    return False


# --- 修复 ---
def repair_restart() -> bool:
    log("→ 执行 bridge restart 拉回...")
    try:
        # 必须带 restart 子命令：裸命令默认落入前台 run —— daemon 还活着时
        # 被单进程检查拒绝(rc=1)，死掉时前台阻塞到 60s 超时，哪种都修不了。
        r = subprocess.run([*RESTART_CMD.split(), "restart"], capture_output=True, text=True, timeout=60)
    except (subprocess.SubprocessError, FileNotFoundError):
        r = None
    if r is not None and r.returncode == 0:
        log("✓ restart 成功，等待探测恢复...")
        time.sleep(RECOVER_WAIT_S)
        # 只有明确健康才算修复成功；probe() 返回 None（判不出）不算。
        if probe() is True:
            write_fails(0)
            log("✓ 自愈完成（restart）")
            return True
    return False


def _build_omp_context() -> str:
    return (
        "任务：修复 feishu-omp-bridge 守护进程，使其恢复在线。\n"
        "背景：bridge 反复 restart 后仍未在 30 秒内连上飞书（自愈 watchdog 触发）。\n"
        "\n"
        "必须严格按顺序执行：\n"
        f"  1. 诊断：查看日志定位根因\n"
        f"     tail -50 {os.path.join(STATE_DIR, 'logs', 'daemon-stderr.log')}\n"
        f"     tail -50 {os.path.join(STATE_DIR, 'logs', 'daemon-stdout.log')}\n"
        f"  2. 修复：按根因处理。常见：dist 与源码不一致(运行 pnpm build)、\n"
        f"     依赖损坏(pnpm install)、launchd plist 异常({RESTART_CMD} start 重装)、\n"
        "     飞书凭据失效。若是代码问题，改源码后 pnpm typecheck && pnpm test && pnpm build。\n"
        f"  3. 启动：运行 {RESTART_CMD} restart，然后验证 {RESTART_CMD} status 显示\"正在后台运行\"。\n"
        "  4. 结束：确认在线后，输出一句话结论（修复了什么、当前是否在线），立即停止。\n"
        "\n"
        f"成功标准：{RESTART_CMD} status 显示 daemon 在线（\"正在后台运行\"或\"正在运行\"）。\n"
        "\n"
        "硬性约束：\n"
        "  - 只做 bridge 自愈这一件事，禁止任何无关的改动/重构/优化/新功能。\n"
        "  - 禁止询问用户或等待确认，直接执行，非交互。\n"
        "  - 步骤 1-4 全部完成（无论成败）后必须结束，不要继续探索、不要追加任务。\n"
        "  - 若按上述仍无法修复：输出失败结论 + 最后诊断，然后结束。\n"
        "\n"
        f"仓库路径：{REPO}"
    )


def repair_with_omp() -> bool:
    log("→ 唤起 omp 修复会话（restart 仍失败）...")
    ctx = _build_omp_context()
    try:
        # -p 非交互 + --mode json：omp 没有 --print-json-lines 这个 flag
        # （旧代码每次 1 秒即败，最后防线从未生效过）。
        r = subprocess.run(
            [OMP_BIN, "run", "--cwd", REPO, "-p", "--mode", "json", "--model", HEAL_MODEL, ctx],
            capture_output=True, timeout=OMP_TIMEOUT_S,
        )
        ok = r.returncode == 0
    except (subprocess.SubprocessError, FileNotFoundError):
        ok = False
    if ok:
        log("✓ omp 修复会话已执行")
        time.sleep(RECOVER_WAIT_S)
        if probe() is True:
            write_fails(0)
            _write_state({"ompAttempts": 0, "nextOmpAt": 0})
            log("✓ 自愈完成（omp 修复）")
            return True
    else:
        log("✗ omp 修复会话失败或超时")
    return False


def _git_head() -> str:
    """当前 HEAD 完整 SHA（仓库不存在/异常时返回 ''）。"""
    try:
        r = subprocess.run(["git", "rev-parse", "HEAD"], cwd=REPO, capture_output=True, text=True, timeout=10)
        if r.returncode == 0:
            return r.stdout.strip()
    except Exception:
        pass
    return ""


def _git_rev(ref: str) -> str:
    """解析任意 ref（如 HEAD~1、<sha>~1）为完整 SHA。失败返回 ''。"""
    try:
        r = subprocess.run(["git", "rev-parse", ref], cwd=REPO, capture_output=True, text=True, timeout=10)
        if r.returncode == 0:
            return r.stdout.strip()
    except Exception:
        pass
    return ""


def _git_commit_time(ref: str) -> int:
    """ref 的 commit unix 时间戳。失败返回 0。"""
    try:
        r = subprocess.run(
            ["git", "log", "-1", "--format=%ct", ref],
            cwd=REPO, capture_output=True, text=True, timeout=10,
        )
        if r.returncode == 0:
            return int(r.stdout.strip() or "0")
    except Exception:
        pass
    return 0


def _dist_matches_head(head: str) -> bool:
    """dist/cli.js 存在且 mtime 不早于 HEAD commit 时间 → dist 是当前 HEAD
    build 出的。避免把「HEAD 已前进但 dist 还是旧代码」记成 good sha。"""
    commit_time = _git_commit_time(head)
    if commit_time <= 0:
        return False
    dist = Path(REPO) / "dist" / "cli.js"
    try:
        return dist.exists() and dist.stat().st_mtime >= commit_time
    except OSError:
        return False


def _git_dirty() -> bool:
    """工作区是否有未提交改动。git 异常时保守返回 True（照旧 stash 保底）。"""
    try:
        r = subprocess.run(
            ["git", "status", "--porcelain"],
            cwd=REPO, capture_output=True, text=True, timeout=15,
        )
    except (subprocess.SubprocessError, FileNotFoundError):
        return True
    return bool((r.stdout or "").strip())


def _run_build() -> str:
    """跑 `pnpm build`，返回 'ok' / 'fail'（非零退出）/ 'env'（超时或跑不起来）。

    超时与失败必须分开：build 超时是"机器忙"，不是"这个提交的代码坏"；
    旧实现把 TimeoutExpired 抛给外层 except，于是回退停在中途 —— HEAD 已
    回退、dist 却是半成品，用户的提交也被静默换掉。"""
    try:
        b = subprocess.run(
            ["pnpm", "build"], cwd=REPO, capture_output=True, text=True, timeout=BUILD_TIMEOUT_S
        )
    except subprocess.TimeoutExpired:
        return "env"
    except (subprocess.SubprocessError, FileNotFoundError):
        return "env"
    return "ok" if b.returncode == 0 else "fail"


def _restore_head(pre_head: str, stashed: bool) -> None:
    """把仓库恢复到回退前的 HEAD，并尽力让 dist 与它一致。

    回退中途失败时的兜底：宁可留在原状态（下一轮/人工继续），也不要留下
    「HEAD 回退了、dist 是半成品」的漂移状态。"""
    try:
        r = subprocess.run(
            ["git", "reset", "--hard", pre_head], cwd=REPO, capture_output=True, text=True, timeout=30
        )
    except (subprocess.SubprocessError, FileNotFoundError) as err:
        log(f"✗ 恢复原 HEAD 失败: {err}")
        return
    if r.returncode != 0:
        log(f"✗ 恢复原 HEAD 失败: {(r.stderr or '').strip() or 'unknown'}")
        return
    log(f"✓ 已恢复原 HEAD {pre_head[:12]}")
    if stashed:
        # 回退前 stash 的用户改动要还回去，不留悬空 stash。
        try:
            p = subprocess.run(["git", "stash", "pop"], cwd=REPO, capture_output=True, text=True, timeout=30)
            if p.returncode != 0:
                log(f"⚠ stash pop 失败，改动仍在 stash 中: {(p.stderr or '').strip()}")
        except (subprocess.SubprocessError, FileNotFoundError) as err:
            log(f"⚠ stash pop 异常，改动仍在 stash 中: {err}")
    if _run_build() != "ok":
        log("⚠ 恢复后重建 dist 未成功，dist 可能与 HEAD 不一致（下一轮自愈会重试）")


def repair_rollback() -> bool:
    """代码坏了时按优先级恢复：
    1) 优先回退到 lastGoodSha（最近验证过健康、且 dist 匹配的提交）；
    2) 失败则进入阶梯退避 —— 可能只是暂时性环境故障，先等再试；
    3) 退避过后仍失败，从 lastGoodSha 起一个个 commit 往前回退尝试。
    每一步都 build + restart + probe；最多退 MAX_ROLLBACK_STEPS 步。
    返回 True 表示回退后 probe 恢复。"""
    if os.environ.get("HEAL_ROLLBACK", "1") != "1":
        log("→ 跳过 rollback（HEAL_ROLLBACK=0）")
        return False
    head = _git_head()
    if not head:
        log("→ 无法读取 git HEAD，跳过 rollback")
        return False
    state = _read_state()
    last_good = str(state.get("lastGoodSha") or "").strip()
    cursor = str(state.get("rollbackCursor") or "").strip()
    steps = int(state.get("rollbackSteps") or 0)
    backoff_until = int(state.get("rollbackBackoffUntil") or 0)
    now = int(time.time())

    # 退避：每次回退尝试之间阶梯间隔，防对暂时性故障连续过激回退。
    if backoff_until and now < backoff_until:
        log(f"⏳ 回退退避中（剩 {backoff_until - now}s）")
        return False
    # 步数上限：退太多就停，交给 omp。
    if steps >= MAX_ROLLBACK_STEPS:
        log(f"✗ 回退已达上限 {MAX_ROLLBACK_STEPS} 步，交给 omp")
        return False

    # target 决策：游标驱动逐节点 > 优先 lastGoodSha > lastGood 往前 > HEAD~1。
    if cursor:
        target = f"{cursor}~1"
    elif last_good and last_good != head:
        target = last_good
    elif last_good:
        target = f"{last_good}~1"
    else:
        target = "HEAD~1"

    target_sha = _git_rev(target)
    if not target_sha:
        log("→ 无法解析回退目标，跳过 rollback")
        return False

    log(f"→ 尝试回退到 {target}（第 {steps + 1}/{MAX_ROLLBACK_STEPS} 步）...")
    try:
        # 只在真有未提交改动时 stash：clean 工作区 stash 是空操作，但会
        # 留下一个需要人工清理的悬空 stash 记录。
        stashed = False
        if _git_dirty():
            subprocess.run(["git", "stash", "-q"], cwd=REPO, capture_output=True, timeout=30)
            stashed = True
        # reset --hard 而非 checkout：留在当前分支上（checkout detached HEAD
        # 会让后续 self-update 的 ff-only pull 语义彻底混乱）。
        r = subprocess.run(
            ["git", "reset", "--hard", target], cwd=REPO, capture_output=True, text=True, timeout=30
        )
        if r.returncode != 0:
            log(f"✗ git reset 失败: {(r.stderr or '').strip() or 'unknown'}")
            return False
        new_head = _git_head()
        if not new_head:
            return False
        log(f"✓ 已回退到 {new_head[:12] or '?'}")
        # 重建 dist
        build = _run_build()
        if build == "env":
            # 超时/命令跑不起来 = 环境问题，不构成"这个提交坏"的证据：
            # 恢复原 HEAD（用户的提交不能被静默换掉），也不推进游标。
            log("✗ rollback 后 build 超时或无法执行（环境问题，非代码问题），恢复原 HEAD")
            _restore_head(head, stashed)
            return False
        if build == "fail":
            log("✗ rollback 后 build 失败，推进游标退更早节点")
            backoff = min((2 ** steps) * ROLLBACK_BASE_S, ROLLBACK_MAX_S)
            _write_state({
                "rollbackCursor": target_sha,
                "rollbackSteps": steps + 1,
                "rollbackBackoffUntil": now + backoff,
            })
            return False
        # 重启并验证
        if repair_restart():
            # 回退成功同样是"自愈完成"：更新已知好版本，清零计数与游标。
            _write_state({
                "ompAttempts": 0, "nextOmpAt": 0,
                "lastGoodSha": new_head, "rollbackCursor": "",
                "rollbackSteps": 0, "rollbackBackoffUntil": 0,
            })
            log("✓ 回退 + 重建 + 重启成功，自愈完成")
            return True
        backoff = min((2 ** steps) * ROLLBACK_BASE_S, ROLLBACK_MAX_S)
        _write_state({
            "rollbackCursor": target_sha,
            "rollbackSteps": steps + 1,
            "rollbackBackoffUntil": now + backoff,
        })
        log(f"✗ 此节点回退后仍失败，{backoff}s 后尝试更早节点")
        return False
    except Exception as err:
        log(f"✗ rollback 异常: {err}")
        return False

def repair_with_omp_guarded() -> bool:
    now = int(time.time())
    attempts = state_get("ompAttempts")
    if attempts >= MAX_ATTEMPTS:
        log(f"✗ 已到达 omp 修复次数上限 {MAX_ATTEMPTS}，停止自愈。需人工介入：")
        log(f"    查看日志: tail -f {os.path.join(STATE_DIR, 'logs', 'daemon-stderr.log')}")
        return False
    next_at = state_get("nextOmpAt")
    if next_at > now:
        log(f"⏳ omp 修复退避中（剩 {next_at - now}s）")
        return False
    # 回退退避中：先等回退退避结束，不抢跑 omp（omp 是回退之后的兜底）。
    rb_backoff = int(_read_state().get("rollbackBackoffUntil") or 0)
    if rb_backoff and now < rb_backoff:
        log(f"⏳ 回退退避中（剩 {rb_backoff - now}s），暂不 omp")
        return False
    omp_lock = DirLock(LOCK_FILE + ".omp")
    if not omp_lock.acquire():
        log("✗ 已有 omp 修复会话在运行，跳过本轮")
        return False
    ok = False  # 初始化：repair_with_omp 若抛异常，finally 后仍安全
    try:
        # 代码损坏优先回滚到上一个稳定提交 —— 比让 omp 现场改代码更稳。
        if repair_rollback():
            return True
        ok = repair_with_omp()
    finally:
        omp_lock.release()
    if ok:
        return True
    # 阶梯退避：2^attempts 分钟，上限 BACKOFF_MAX_S
    backoff = min((2 ** attempts) * BACKOFF_BASE_S, BACKOFF_MAX_S)
    _write_state({"ompAttempts": attempts + 1, "nextOmpAt": now + backoff})
    if attempts + 1 >= MAX_ATTEMPTS:
        log(f"⏳ omp 修复失败（第 {attempts + 1}/{MAX_ATTEMPTS} 次），已达上限，停止自愈。需人工介入。")
    else:
        log(f"⏳ omp 修复失败，退避 {backoff}s 后重试（第 {attempts + 1}/{MAX_ATTEMPTS} 次）")
    return False


def heal_once() -> None:
    verdict = probe()
    if verdict is True:
        write_fails(0)
        # 健康时记录当前提交为"已知好版本"，供 rollback 精确回退。只有
        # dist 确实由当前 HEAD build 出才记 —— 否则 HEAD 已前进但 dist 还
        # 是旧代码，记了会把坏提交误当 good。
        head = _git_head()
        if head and _dist_matches_head(head):
            _write_state({
                "lastGoodSha": head, "rollbackCursor": "",
                "rollbackSteps": 0, "rollbackBackoffUntil": 0,
            })
        return
    if verdict is None:
        # 判不出（探针超时/无法执行）不动手，也不计入连续异常：把"慢"
        # 当成"死"正是 2026-09-24 对健康 daemon 做破坏性 restart 的起点。
        # 只更新 lastCheck，让 heal-state 仍能反映"看门狗活着，只是判不出"。
        _write_state({"lastCheck": _now_iso()})
        return
    fails = state_get("fails") + 1
    write_fails(fails)
    log(f"连续异常 {fails}/{FAIL_THRESHOLD}")
    if fails >= FAIL_THRESHOLD:
        write_fails(0)  # 重置，避免阈值耗尽后每轮都打 omp
        # 动手前复检：阈值是几轮前攒下的，期间 daemon 可能已经自己恢复，
        # 或者只是探针慢。只有复检仍明确判死才做破坏性动作。
        if probe() is not False:
            log("✗ 复检未确认假死（探针判不出或已恢复），放弃本轮修复")
            return
        if repair_restart():
            return
        repair_with_omp_guarded()


# --- launchd 安装/卸载 ---
def _find_python() -> str:
    """定位可用的 python3 解释器，供 launchd plist 写死绝对路径。

    优先系统自带 /usr/bin/python3（macOS 永在），需实测可执行（是 shim，
    仅 -x 不够）；其次 PATH 里的 python3（可能是 brew 新版）。
    返回的路径写入 plist 的 ProgramArguments，安装时固化。
    """
    for cand in ("/usr/bin/python3",):
        if os.path.isfile(cand) and subprocess.run(
            [cand, "--version"], capture_output=True, timeout=5
        ).returncode == 0:
            return cand
    p = shutil.which("python3")
    if p:
        return p
    raise RuntimeError("找不到可用的 python3，无法安装 watchdog")


def install() -> None:
    plist_path = Path.home() / "Library" / "LaunchAgents" / f"{SERVICE_LABEL}.plist"
    plist_path.parent.mkdir(parents=True, exist_ok=True)
    # 安装时探测稳定 python 绝对路径并写死 —— 单一实现（全 Python），
    # 不引入 shell 薄壳。若日后 python 路径失效，重跑 install 重新固化。
    py = _find_python()
    script = str(Path(__file__).resolve())
    content = f"""<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>{SERVICE_LABEL}</string>
    <key>ProgramArguments</key>
    <array>
        <string>{py}</string>
        <string>{script}</string>
    </array>
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <true/>
    <key>ThrottleInterval</key>
    <integer>10</integer>
    <key>StandardOutPath</key>
    <string>{LOG_FILE}</string>
    <key>StandardErrorPath</key>
    <string>{LOG_FILE}</string>
    <key>EnvironmentVariables</key>
    <dict>
        <key>PATH</key>
        <string>{os.environ.get('PATH', '')}</string>
    </dict>
</dict>
</plist>
"""
    plist_path.write_text(content, encoding="utf-8")
    subprocess.run(["launchctl", "bootstrap", f"gui/{os.getuid()}", str(plist_path)], check=False)
    log(f"✓ watchdog 已注册并启动 (ai.feishu-omp-bridge.heal, python={py})")


def uninstall() -> None:
    subprocess.run(["launchctl", "bootout", f"gui/{os.getuid()}/{SERVICE_LABEL}"], check=False)
    plist_path = Path.home() / "Library" / "LaunchAgents" / f"{SERVICE_LABEL}.plist"
    plist_path.unlink(missing_ok=True)
    log("✓ watchdog 已卸载")


def main() -> None:
    arg = sys.argv[1] if len(sys.argv) > 1 else ""
    # install / uninstall 是管理操作，不受 watchdog 常驻锁影响。
    if arg == "install":
        install()
        return
    if arg == "uninstall":
        uninstall()
        return
    if arg == "--repair":
        # --repair 是 service.ts SELF_HEAL=1 的快速修复路径。它要防的是并发
        # omp 会话，不是并发探测 —— repair_with_omp_guarded 内部已用 omp 锁
        # 互斥。若在此抢主锁：常驻 watchdog 永远持有它，这条路径必然被拒。
        repair_with_omp_guarded()
        return
    # 探测/常驻：同一时间只允许一个实例
    lock = DirLock(LOCK_FILE)
    if not lock.acquire():
        log("✗ 已有自愈看门狗在运行，本轮跳过。")
        sys.exit(2)
    try:
        if arg == "--once":
            heal_once()
        else:
            # 常驻循环（launchd 拉起后用）
            while True:
                heal_once()
                time.sleep(INTERVAL_S)
    finally:
        lock.release()


if __name__ == "__main__":
    main()
