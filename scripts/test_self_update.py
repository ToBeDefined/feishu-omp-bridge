"""self-update.py 的 pytest 测试。

替代原 verify-self-update.sh（bash + eval 断言）。用临时 git 仓库 +
UPDATE_GATES 门禁注入驱动 self-update 模块，覆盖：

  1. 全部通过 → 更新到新 HEAD + restart
  2. typecheck 失败 → 回滚旧 HEAD + 不 restart
  3. test 失败 → 回滚
  4. build 失败 → 回滚
  5. restart 失败 → 回滚
  6. 锁互斥（已有更新 → 跳过）

运行：python3 -m pytest scripts/test_self_update.py -v
"""

import importlib.util
import os
import subprocess
from pathlib import Path

import pytest

SCRIPT = Path(__file__).parent / "self-update.py"


def load_module():
    spec = importlib.util.spec_from_file_location("self_update", SCRIPT)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


@pytest.fixture()
def upd(tmp_path, monkeypatch):
    """构造隔离 git 仓库（bare origin 含 old+new）+ 模块实例。"""
    # bare origin
    origin = tmp_path / "origin.git"
    repo = tmp_path / "repo"
    subprocess.run(["git", "init", "-q", "--bare", str(origin)], check=True)
    subprocess.run(["git", "init", "-q", str(repo)], check=True)
    subprocess.run(["git", "-C", str(repo), "config", "user.email", "t@t"], check=True)
    subprocess.run(["git", "-C", str(repo), "config", "user.name", "t"], check=True)
    subprocess.run(["git", "-C", str(repo), "remote", "add", "origin", str(origin)], check=True)

    (repo / "src").mkdir()
    (repo / "dist").mkdir()
    (repo / "bin").mkdir()
    (repo / "src" / "index.ts").write_text("console.log('old')")
    (repo / "package.json").write_text('{"scripts":{"typecheck":"x","test":"x","build":"x"}}')
    (repo / "bin" / "feishu-omp-bridge.mjs").write_text("#!/usr/bin/env node\n")
    (repo / "dist" / "cli.js").write_text("OLD-DIST")
    subprocess.run(["git", "-C", str(repo), "add", "-A"], check=True)
    subprocess.run(["git", "-C", str(repo), "commit", "-qm", "old"], check=True)
    subprocess.run(["git", "-C", str(repo), "push", "-q", "-u", "origin", "HEAD:main"], check=True)
    old_head = subprocess.run(
        ["git", "-C", str(repo), "rev-parse", "--short", "HEAD"], capture_output=True, text=True
    ).stdout.strip()
    (repo / "src" / "index.ts").write_text("console.log('new')")
    subprocess.run(["git", "-C", str(repo), "add", "-A"], check=True)
    subprocess.run(["git", "-C", str(repo), "commit", "-qm", "new"], check=True)
    new_head = subprocess.run(
        ["git", "-C", str(repo), "rev-parse", "--short", "HEAD"], capture_output=True, text=True
    ).stdout.strip()
    subprocess.run(["git", "-C", str(repo), "push", "-q", "origin", "HEAD:main"], check=True)
    subprocess.run(["git", "-C", str(repo), "reset", "-q", "--hard", old_head], check=True)

    mod = load_module()
    monkeypatch.setattr(mod, "REPO", str(repo))
    monkeypatch.setattr(mod, "LOCK_FILE", str(tmp_path / "update.lock"))
    monkeypatch.setattr(mod, "LOG_FILE", str(tmp_path / "update.log"))
    monkeypatch.setattr(mod, "BRANCH", "")  # 防 pytest argv 污染 branch 参数

    # 记录 old/new head 供断言
    mod.OLD_HEAD = old_head
    mod.NEW_HEAD = new_head

    # 门禁：UPDATE_GATES JSON 覆盖（如 {"typecheck": false}）；restart 结果可控
    state = {"restart_ok": True}
    calls = {"restart": 0}

    def fake_run(cmd, **kw):
        argv = cmd if isinstance(cmd, list) else str(cmd).split()
        if len(argv) >= 3 and "feishu-omp-bridge.mjs" in argv[1] and argv[2] == "restart":
            calls["restart"] += 1
            return subprocess.CompletedProcess(argv, 0 if state["restart_ok"] else 1)
        if len(argv) >= 3 and "feishu-omp-bridge.mjs" in argv[1] and argv[2] == "status":
            return subprocess.CompletedProcess(argv, 0)
        # 其余（pnpm/git）走真实命令 —— 用真实 subprocess
        return subprocess.run(cmd, capture_output=True, text=True,
                              cwd=kw.get("cwd", mod.REPO))

    monkeypatch.setattr(mod, "run", fake_run)
    mod.state = state
    mod.calls = calls

    # 默认门禁全过
    monkeypatch.setattr(mod, "os", __import__("os"))
    os.environ["UPDATE_GATES"] = "{}"
    mod.UPDATE_GATES = {}
    return mod


def _gates(upd, **kw):
    import json

    g = {"typecheck": True, "test": True, "build": True}
    g.update(kw)
    upd.os.environ["UPDATE_GATES"] = json.dumps(g)


def _cur_head(upd):
    r = subprocess.run(["git", "-C", upd.REPO, "rev-parse", "--short", "HEAD"],
                       capture_output=True, text=True)
    return r.stdout.strip()


def _cur_head(upd):
    r = subprocess.run(["git", "-C", upd.REPO, "rev-parse", "--short", "HEAD"],
                       capture_output=True, text=True)
    return r.stdout.strip()


# 1. 全部通过 → 更新到新 HEAD + restart
def test_update_success(upd):
    _gates(upd)
    rc = upd.update()
    assert rc == 0
    assert _cur_head(upd) == upd.NEW_HEAD
    assert upd.calls["restart"] == 1


# 2. typecheck 失败 → 回滚 + 不 restart
def test_typecheck_fail_rolls_back(upd):
    _gates(upd, typecheck=False)
    rc = upd.update()
    assert rc == 1
    assert _cur_head(upd) == upd.OLD_HEAD  # 回滚到旧 HEAD
    assert upd.calls["restart"] == 0


# 3. test 失败 → 回滚
def test_test_fail_rolls_back(upd):
    _gates(upd, test=False)
    rc = upd.update()
    assert rc == 1
    assert _cur_head(upd) == upd.OLD_HEAD
    assert upd.calls["restart"] == 0


# 4. build 失败 → 回滚
def test_build_fail_rolls_back(upd):
    _gates(upd, build=False)
    rc = upd.update()
    assert rc == 1
    assert _cur_head(upd) == upd.OLD_HEAD
    assert upd.calls["restart"] == 0


# 5. restart 失败 → 回滚
def test_restart_fail_rolls_back(upd):
    _gates(upd)
    upd.state["restart_ok"] = False
    rc = upd.update()
    assert rc == 1
    assert _cur_head(upd) == upd.OLD_HEAD


# 6. 锁互斥
def test_update_lock_conflict(upd, tmp_path):
    # 预占锁
    lock_dir = tmp_path / "update.lock.d"
    lock_dir.mkdir()
    rc = upd.main()
    assert rc == 2
