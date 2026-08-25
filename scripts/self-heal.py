#!/usr/bin/env python3
"""自愈看门狗：定期健康探测 bridge daemon，异常时自动修复。

功能等价于原 self-heal.sh（Python 重写，接口一致）：

  探测维度（每 60s，连续 FAIL_THRESHOLD 次异常才算"假死"）：
    1. 进程存活  —— 有 feishu-omp-bridge.mjs run 进程
    2. WS 连通    —— bridge status 显示正在后台运行
  OMP 是 bridge 的外部依赖；它不可用时由具体 agent 请求报告错误，不能
  反过来把在线 bridge 判成假死并触发破坏性重启或回滚。

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
  HEAL_BACKOFF_BASE_S / HEAL_BACKOFF_MAX_S / HEAL_MAX_ATTEMPTS
"""

import json
import os
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


def write_fails(fails: int) -> None:
    _write_state({"fails": fails, "lastCheck": datetime.now().strftime("%Y-%m-%dT%H:%M:%S")})


# --- 健康探测 ---
def _proc_alive() -> bool:
    try:
        out = subprocess.run(
            ["pgrep", "-f", PGREP_PATTERN], capture_output=True, text=True, timeout=5
        )
        return out.returncode == 0
    except (subprocess.SubprocessError, FileNotFoundError):
        return False


def _ws_connected() -> bool:
    """WS 活跃探测。优先用 `bridge status`（检查 launchd 服务加载 + 进程
    注册），比只看 processes.json 的 botName 静态标记更能捕获'进程活着但
    WS 假死/服务未加载'。status 非零退出 = 不在后台运行。"""
    try:
        r = subprocess.run(
            [*RESTART_CMD.split(), "status"],
            capture_output=True, text=True, timeout=15,
        )
        if r.returncode == 0 and "正在后台运行" in r.stdout:
            return True
        return False
    except (subprocess.SubprocessError, FileNotFoundError, IndexError):
        # 兜底：回退到 botName 静态标记
        try:
            with open(os.path.join(STATE_DIR, "processes.json"), encoding="utf-8") as f:
                return '"botName"' in f.read()
        except OSError:
            return False




def probe() -> bool:
    healthy = True
    if not _proc_alive():
        log("✗ 进程不存在")
        healthy = False
    if not _ws_connected():
        log("✗ 未检测到 WS 连接(processes.json 无 botName)")
        healthy = False
    return healthy


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
        if probe():
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
        if probe():
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
        # 每次 reset 前 stash：幂等（clean 工作区时 git stash 无操作），
        # 但能保底任何未提交改动 —— 包括回退期间用户/其他进程的手动修改。
        subprocess.run(["git", "stash", "-q"], cwd=REPO, capture_output=True, timeout=30)
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
        b = subprocess.run(["pnpm", "build"], cwd=REPO, capture_output=True, text=True, timeout=120)
        if b.returncode != 0:
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
    if probe():
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
    fails = state_get("fails") + 1
    write_fails(fails)
    log(f"连续异常 {fails}/{FAIL_THRESHOLD}")
    if fails >= FAIL_THRESHOLD:
        write_fails(0)  # 重置，避免阈值耗尽后每轮都打 omp
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
