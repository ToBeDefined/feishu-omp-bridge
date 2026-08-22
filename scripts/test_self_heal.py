"""self-heal.py 的 pytest 测试。

替代原 verify-self-heal.sh（bash + eval 断言）。用 pytest 的
monkeypatch/tmp_path 直接驱动 self-heal 模块，覆盖全部自愈行为：

  1. 健康探测不误报           2. 进程死 → restart 自愈
  3. WS 断连 → restart         4. omp 不可用判异常
  5. restart 失败 → 唤起 omp   6. 主锁互斥
  7. 阶梯退避                  8. omp 并发锁
  9. 修复成功闭环             10. 最大次数上限
  11. 提示词契约              12. SIGKILL 后锁自动释放

运行：python3 -m pytest scripts/test_self_heal.py -v
"""

import importlib.util
import os
import subprocess
import sys
import time
from pathlib import Path

import pytest

SCRIPT = Path(__file__).parent / "self-heal.py"


def load_module():
    spec = importlib.util.spec_from_file_location("self_heal", SCRIPT)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


@pytest.fixture()
def heal(tmp_path, monkeypatch):
    mod = load_module()

    # 隔离所有状态/锁/日志到 tmp
    monkeypatch.setattr(mod, "STATE_DIR", str(tmp_path))
    monkeypatch.setattr(mod, "STATE_FILE", str(tmp_path / "heal-state.json"))
    monkeypatch.setattr(mod, "LOCK_FILE", str(tmp_path / "heal.lock"))
    monkeypatch.setattr(mod, "LOG_FILE", str(tmp_path / "heal.log"))
    # 原 omp 测试语义：跳过 rollback（单独测 rollback）
    monkeypatch.setenv("HEAL_ROLLBACK", "0")
    # rollback 会在 REPO 跑 git/build —— 隔离到 tmp 避免碰真仓库
    monkeypatch.setattr(mod, "REPO", str(tmp_path))

    # 可控假命令：记录调用，退出码由模块变量决定
    calls = {"restart": 0, "omp_run": 0, "ctx": None, "git_reset": 0, "git_checkout": 0, "build": 0}

    def fake_run(cmd, **kw):
        argv = cmd if isinstance(cmd, list) else str(cmd).split()
        # restart: RESTART_CMD.split() → ["fake-restart"]
        # omp run:  ["fake-omp", "run", ...]
        if argv and argv[0] == "fake-restart":
            calls["restart"] += 1
            # restart 动作让进程复活 + 写回 botName（模拟修复 WS）
            if getattr(mod, "RESTART_FIX", False):
                probe_state["alive"] = True
                (tmp_path / "processes.json").write_text(
                    '{"entries":[{"botName":"Agent","pid":123}]}'
                )
            rc = 0 if getattr(mod, "RESTART_OK", True) else 1
        elif len(argv) >= 2 and argv[0] == "fake-omp" and argv[1] == "run":
            calls["omp_run"] += 1
            calls["ctx"] = argv[-1]
            rc = 0 if getattr(mod, "OMP_RUN_OK", False) else 1
            if rc == 0 and getattr(mod, "OMP_RUN_FIX", False):
                probe_state["alive"] = True
                (tmp_path / "processes.json").write_text(
                    '{"entries":[{"botName":"Agent","pid":123}]}'
                )
        else:
            # rollback 流程: git stash / git rev-parse / git reset / pnpm build
            if argv and argv[0] == "git":
                if len(argv) >= 2 and argv[1] == "rev-parse":
                    return subprocess.CompletedProcess(argv, 0, stdout="abc123def456")
                if len(argv) >= 2 and argv[1] == "reset":
                    calls["git_reset"] += 1
                elif len(argv) >= 2 and argv[1] == "checkout":
                    calls["git_checkout"] += 1
                rc = 0
            elif argv and argv[0] == "pnpm":
                calls["build"] += 1
                rc = 0 if getattr(mod, "BUILD_OK", True) else 1
                return subprocess.CompletedProcess(argv, rc)
            else:
                rc = 0
        return subprocess.CompletedProcess(argv, rc)

    # 探测：进程/omp 用可控 state；WS 读真实 processes.json（restart 修复后
    # RESTART_FIX 会写回 botName，需真实读取才能验证闭环）。
    probe_state = {"alive": True, "omp": True}

    def _proc_alive():
        return probe_state["alive"]

    def _ws_connected():
        try:
            return '"botName"' in (tmp_path / "processes.json").read_text()
        except OSError:
            return False

    def _omp_available():
        return probe_state["omp"]

    monkeypatch.setattr(mod, "subprocess", type("SP", (), {"run": staticmethod(fake_run)})())
    monkeypatch.setattr(mod, "RESTART_CMD", "fake-restart")
    monkeypatch.setattr(mod, "OMP_BIN", "fake-omp")
    monkeypatch.setattr(mod, "_proc_alive", _proc_alive)
    monkeypatch.setattr(mod, "_ws_connected", _ws_connected)
    monkeypatch.setattr(mod, "_omp_available", _omp_available)

    # 默认参数
    mod.RECOVER_WAIT_S = 0
    mod.FAIL_THRESHOLD = 2
    mod.BACKOFF_BASE_S = 0
    mod.MAX_ATTEMPTS = 10
    mod.RESTART_OK = True
    mod.RESTART_FIX = True
    mod.OMP_RUN_OK = False

    mod.calls = calls
    mod.probe_state = probe_state
    # 默认健康：有 botName（RESTART_FIX/断连测试会改）
    (tmp_path / "processes.json").write_text('{"entries":[{"botName":"Agent","pid":123}]}')
    return mod




def test_healthy_records_good_sha_only_when_dist_matches(heal, monkeypatch):
    """健康时仅在 dist 确由当前 HEAD build 出才更新 lastGoodSha。"""
    monkeypatch.setattr(heal, "_git_head", lambda: "new")

    # dist 匹配 → 记录
    monkeypatch.setattr(heal, "_dist_matches_head", lambda head: True)
    heal.heal_once()
    assert heal._read_state().get("lastGoodSha") == "new"

    # dist 不匹配 → 保留旧值，不把"没 build 的新 HEAD"记成 good
    heal._write_state({"lastGoodSha": "old"})
    monkeypatch.setattr(heal, "_dist_matches_head", lambda head: False)
    heal.heal_once()
    assert heal._read_state().get("lastGoodSha") == "old"


# --- 1. 健康探测不误报 ---
def test_healthy_no_false_alarm(heal):
    heal.heal_once()
    assert heal.state_get("fails") == 0
    assert heal.calls["restart"] == 0

# --- 2. 进程死 → 连续异常 → restart 自愈 ---
def test_proc_dead_triggers_restart(heal):
    heal.probe_state["alive"] = False
    heal.heal_once()  # fails=1
    assert heal.state_get("fails") == 1
    heal.heal_once()  # 达阈值 → restart（fake 复活进程+写回 botName）→ 恢复
    assert heal.calls["restart"] == 1
    assert heal.state_get("fails") == 0


# --- 3. WS 断连(无 botName) → restart ---
def test_ws_disconnect_triggers_restart(heal):
    (heal.STATE_DIR and Path(heal.STATE_DIR) / "processes.json").unlink(missing_ok=True)
    heal.heal_once()
    heal.heal_once()
    assert heal.calls["restart"] == 1


# --- 4. omp 不可用 → 判异常 ---
def test_omp_unavailable_counts_failure(heal):
    heal.probe_state["omp"] = False
    heal.heal_once()
    assert heal.state_get("fails") >= 1


# --- 5. restart 失败 → 唤起 omp ---
def test_restart_fail_invokes_omp(heal):
    heal.probe_state["alive"] = False
    (heal.STATE_DIR and Path(heal.STATE_DIR) / "processes.json").unlink(missing_ok=True)
    heal.RESTART_OK = False
    heal.RESTART_FIX = False  # restart 失败,持续断连
    heal.OMP_RUN_OK = True
    heal.heal_once()
    heal.heal_once()
    assert heal.calls["omp_run"] == 1


# --- 6. 主锁互斥（端到端：真实子进程持锁） ---
def test_main_lock_conflict_skips(heal, tmp_path):
    import fcntl

    lock_file = tmp_path / "held.lock"
    fd = os.open(str(lock_file), os.O_CREAT | os.O_RDWR)
    fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
    try:
        env = dict(os.environ, HEAL_STATE_DIR=str(tmp_path), HEAL_LOCK_FILE=str(lock_file))
        r = subprocess.run([sys.executable, str(SCRIPT), "--once"], env=env,
                           capture_output=True, text=True)
        assert r.returncode == 2  # 锁冲突 → exit 2
    finally:
        fcntl.flock(fd, fcntl.LOCK_UN)
        os.close(fd)


# --- 7. 阶梯退避 ---
def test_omp_backoff(heal):
    heal.probe_state["alive"] = False
    (heal.STATE_DIR and Path(heal.STATE_DIR) / "processes.json").unlink(missing_ok=True)
    heal.RESTART_OK = False
    heal.RESTART_FIX = False  # restart 失败,持续断连
    heal.OMP_RUN_OK = False
    heal.BACKOFF_BASE_S = 600
    heal.heal_once()
    heal.heal_once()  # 达阈值 → restart 失败 → omp 失败 → 设退避
    assert heal.state_get("nextOmpAt") > 0
    # 退避期内再次触发不应唤起 omp
    before = heal.calls["omp_run"]
    heal.heal_once()
    heal.heal_once()
    assert heal.calls["omp_run"] == before


# --- 8. omp 并发锁 ---
def test_omp_concurrency_lock(heal, tmp_path):
    heal.probe_state["alive"] = False
    (heal.STATE_DIR and Path(heal.STATE_DIR) / "processes.json").unlink(missing_ok=True)
    heal.RESTART_OK = False
    heal.RESTART_FIX = False  # restart 失败,持续断连
    heal.OMP_RUN_OK = True
    omp_lock = heal.DirLock(str(tmp_path / "heal.lock.omp"))
    assert omp_lock.acquire()
    try:
        heal.heal_once()
        heal.heal_once()
        assert heal.calls["omp_run"] == 0
    finally:
        omp_lock.release()


# --- 9. 修复成功闭环 ---
def test_omp_success_closes_loop(heal):
    heal.probe_state["alive"] = False
    (Path(heal.STATE_DIR) / "processes.json").unlink(missing_ok=True)
    heal.RESTART_OK = False
    heal.RESTART_FIX = False  # restart 失败,持续断连
    heal.OMP_RUN_OK = True
    heal.OMP_RUN_FIX = True  # omp 修复成功 → 复活 + 写回 botName
    heal.heal_once()
    heal.heal_once()
    assert heal.state_get("fails") == 0
    assert heal.state_get("ompAttempts") == 0


# --- 10. 最大次数上限 ---
def test_max_attempts_stops(heal):
    heal.probe_state["alive"] = False
    (Path(heal.STATE_DIR) / "processes.json").unlink(missing_ok=True)
    heal.RESTART_OK = False   # restart 一直失败
    heal.RESTART_FIX = False  # 不复活 → 持续断连
    heal.OMP_RUN_OK = False
    heal.MAX_ATTEMPTS = 2
    # 触发 2 次 omp 修复失败（每次需 2 次 heal_once 达阈值）
    heal.heal_once(); heal.heal_once()
    heal.heal_once(); heal.heal_once()
    assert heal.state_get("ompAttempts") == 2
    # 再触发 → 已到上限，不再唤起 omp
    before = heal.calls["omp_run"]
    heal.heal_once(); heal.heal_once()
    heal.heal_once(); heal.heal_once()
    assert heal.calls["omp_run"] == before


# --- 11. 提示词契约 ---
def test_prompt_contract(heal):
    ctx = heal._build_omp_context()
    assert "诊断" in ctx
    assert "修复" in ctx
    assert "restart" in ctx
    assert "status" in ctx
    assert "在线" in ctx
    assert "停止" in ctx
    assert "无关" in ctx


def test_rollback_runs_before_omp_when_enabled(heal, tmp_path, monkeypatch):
    # 开启 rollback：restart 失败后应先 git reset + build，再 omp。
    # 预置 lastGoodSha（模拟此前健康时记录的已知好提交）→ 回滚走 reset --hard <sha>。
    monkeypatch.setenv("HEAL_ROLLBACK", "1")
    heal._write_state({"lastGoodSha": "abc123def456"})
    heal.probe_state["alive"] = False
    (tmp_path / "processes.json").unlink(missing_ok=True)
    heal.RESTART_OK = False      # restart 失败
    heal.RESTART_FIX = False
    heal.OMP_RUN_OK = True       # omp 修复成功兜底
    heal.BACKOFF_BASE_S = 0
    heal.heal_once()
    heal.heal_once()             # 达阈值 → restart 失败 → rollback → omp
    assert heal.calls["git_reset"] >= 1     # rollback 执行了 git reset
    assert heal.calls["build"] >= 1         # rollback 执行了 build
    assert heal.calls["omp_run"] >= 1       # rollback 后仍失败才 omp


def _mock_rollback_git(heal, monkeypatch, reset_targets):
    """记录每次 git reset 的 target，git 其余操作与 pnpm 均成功。"""
    def fake_subprocess(cmd, **kw):
        argv = cmd if isinstance(cmd, list) else str(cmd).split()
        if argv and argv[0] == "git" and len(argv) >= 4 and argv[1] == "reset":
            reset_targets.append(argv[3])
        return subprocess.CompletedProcess(argv, 0, stdout="", stderr="")

    monkeypatch.setattr(heal, "subprocess", type("SP", (), {"run": staticmethod(fake_subprocess)})())


def test_rollback_prefers_last_good(heal, monkeypatch):
    """有 lastGoodSha 且 != HEAD 时，优先一步回退到它，而非从头逐节点。"""
    monkeypatch.setenv("HEAL_ROLLBACK", "1")
    heal._write_state({"lastGoodSha": "good", "rollbackCursor": "", "rollbackSteps": 0, "rollbackBackoffUntil": 0})
    monkeypatch.setattr(heal, "_git_head", lambda: "bad")
    monkeypatch.setattr(heal, "_git_rev", lambda ref: "good")
    monkeypatch.setattr(heal, "repair_restart", lambda: False)
    resets = []
    _mock_rollback_git(heal, monkeypatch, resets)

    assert heal.repair_rollback() is False
    assert resets == ["good"]          # 第一步就是 lastGood，不是 HEAD~1
    assert heal._read_state().get("rollbackCursor") == "good"  # 本次试过的节点


def test_rollback_backs_off_after_failure(heal, monkeypatch):
    """失败后进入退避：退避期内不再 reset，避免连续过激回退。"""
    monkeypatch.setenv("HEAL_ROLLBACK", "1")
    heal._write_state({
        "lastGoodSha": "good", "rollbackCursor": "good",
        "rollbackSteps": 1, "rollbackBackoffUntil": int(time.time()) + 3600,
    })
    monkeypatch.setattr(heal, "_git_head", lambda: "bad")
    monkeypatch.setattr(heal, "repair_restart", lambda: False)
    resets = []
    _mock_rollback_git(heal, monkeypatch, resets)

    assert heal.repair_rollback() is False
    assert resets == []               # 退避中，零 reset


def test_rollback_steps_after_backoff(heal, monkeypatch):
    """退避过后从游标父节点继续退；成功后更新 lastGoodSha 并清游标。"""
    monkeypatch.setenv("HEAL_ROLLBACK", "1")
    heal._write_state({
        "lastGoodSha": "good", "rollbackCursor": "good",
        "rollbackSteps": 1, "rollbackBackoffUntil": 0,
    })
    monkeypatch.setattr(heal, "_git_head", lambda: "older")
    monkeypatch.setattr(heal, "_git_rev", lambda ref: "older")
    monkeypatch.setattr(heal, "repair_restart", lambda: True)
    resets = []
    _mock_rollback_git(heal, monkeypatch, resets)

    assert heal.repair_rollback() is True
    assert resets == ["good~1"]       # cursor=good → 退到 good~1
    state = heal._read_state()
    assert state.get("lastGoodSha") == "older"
    assert state.get("rollbackCursor") == ""
    assert state.get("rollbackSteps") == 0


def test_rollback_step_limit(heal, monkeypatch):
    """退满 MAX_ROLLBACK_STEPS 步仍未恢复时停止，交给 omp。"""
    monkeypatch.setenv("HEAL_ROLLBACK", "1")
    heal.MAX_ROLLBACK_STEPS = 3
    heal._write_state({"lastGoodSha": "", "rollbackCursor": "x", "rollbackSteps": 3, "rollbackBackoffUntil": 0})
    monkeypatch.setattr(heal, "_git_head", lambda: "x")
    monkeypatch.setattr(heal, "repair_restart", lambda: False)
    resets = []
    _mock_rollback_git(heal, monkeypatch, resets)

    assert heal.repair_rollback() is False
    assert resets == []               # 步数上限，不再 reset


def test_rollback_skipped_when_disabled(heal, tmp_path, monkeypatch):
    # 默认 HEAL_ROLLBACK=0（fixture）：restart 失败直接 omp，无 git 操作
    heal.probe_state["alive"] = False
    (tmp_path / "processes.json").unlink(missing_ok=True)
    heal.RESTART_OK = False
    heal.OMP_RUN_OK = True
    heal.BACKOFF_BASE_S = 0
    heal.heal_once()
    heal.heal_once()
    assert heal.calls["git_checkout"] == 0
    assert heal.calls["omp_run"] >= 1


# --- 12. SIGKILL 后锁自动释放（关键可靠性） ---
def test_lock_released_after_sigkill(tmp_path):
    import fcntl
    import signal
    import time

    lock_path = tmp_path / "lockfile"
    child_code = f"""
import fcntl, os, time
fd = os.open({str(lock_path)!r}, os.O_CREAT | os.O_RDWR)
fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
print('locked', flush=True)
time.sleep(60)
"""
    child = subprocess.Popen([sys.executable, "-c", child_code],
                             stdout=subprocess.PIPE, text=True)
    child.stdout.readline()
    os.kill(child.pid, signal.SIGKILL)
    child.wait()
    fd = os.open(str(lock_path), os.O_CREAT | os.O_RDWR)
    try:
        fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)  # 不抛即通过
    finally:
        os.close(fd)
