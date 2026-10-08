# kimi（Kimi Code）驱动实测（§1）
> 章节号为本文件自编号（1 起）；跨文件引用写作「文件名 §x.y」。SKILL.md 主入口见 ../SKILL.md。

## 1. 附录：kimi（Kimi Code）驱动实测

### 1.1 进程与文件布局

| 项 | 实测值 |
|---|---|
| 可执行 | `~/.kimi-code/bin/kimi` |
| 运行方式 | **常驻进程**（实测单个 `kimi` 进程存活 1 天+，cwd = 会话工作目录） |
| 状态根 | `~/.kimi-code/`（`config.toml`、`credentials`、`oauth`、`workspaces.json`、`file-history/`） |
| **会话索引** | `~/.kimi-code/session_index.jsonl`，每行 `{sessionId, sessionDir, workDir}`；**只在新会话创建时追加**（mtime 可能远早于当前活动） |
| 会话目录 | `~/.kimi-code/sessions/wd_<cwd 的 basename 小写>_<12 位 hex>/session_<uuid>/`<br>例：cwd=`~/src/example-plugin` → `wd_example-plugin_a1b2c3d4e5f6/session_<uuid>/` |
| 子 agent | 同会话可有多个 `agents/agent-N/`（实测 15 个）；**只有 `agents/main/` 持续写** |

### 1.2 会话内文件与用途

| 文件 | 内容 | 用途 |
|---|---|---|
| `state.json` | `id/version/cwd/archived/title/titleKind/lastPrompt/createdAt/updatedAt/agents{}` | **判活 + 判"最后收到什么指令"**（`updatedAt`、`lastPrompt`）；`title` 是最初目标 |
| `agents/main/wire.jsonl` | 事件流：`turn.prompt` / `agent.message.appended` / `llm.request` / `usage.record` / `file_history.tracked` / `turn.ended` … | **mtime + 字节数 = 是否在推进**；正文在 `"type":"text"`，思考链在 `"type":"think"` |
| `agents/<id>/tasks/*.json` + `output.log` | 该 agent 的 bash 任务与完整输出 | 回看它跑过什么命令、测试 PASS/FAIL 明细 |
| `agents/main/file-history/` | 每次改动的文件快照 | 复盘它改了什么 |
| `notify/state.json` | 通知状态 | — |

### 1.3 判活 / 定位（不读屏三步）

```bash
# 1) 按 cwd 找会话目录（比猜目录名可靠）
python3 - <<'PY'
import json, pathlib
cwd = str(pathlib.Path.home() / "src/example-plugin")  # 换成你的 workDir
for line in reversed(pathlib.Path.home().joinpath(".kimi-code/session_index.jsonl").read_text().splitlines()):
    d = json.loads(line)
    if d["workDir"] == cwd:
        print(d["sessionDir"]); break
PY

# 2) 是否在推进
stat -f '%Sm %z' -t '%H:%M:%S' <sessionDir>/agents/main/wire.jsonl

# 3) 最后收到的指令（判断它到底在做什么）
python3 -c "import json;print(json.load(open('<sessionDir>/state.json'))['lastPrompt'][:80])"
```

**判读**：`wire.jsonl` mtime 在数秒内 = 在跑；停在数分钟前且屏幕输入框为空 = 空闲。
**`state.json.updatedAt` 不能用来判断活跃度**（只在 prompt 变更等时刻更新）——用 `wire.jsonl` 的 mtime。

### 1.4 投递消息（实测完整流程）

```bash
WS=workspace:7
MSG='…你的多行指令…'
cmux set-buffer --name msg "$MSG"
cmux paste-buffer --name msg --workspace "$WS"
cmux send-key --workspace "$WS" Enter

cmux read-screen --workspace "$WS" --lines 12    # 应在 2–3 s 内看到消息回显 + ⠹ thinking…
# 然后再收拾残留行（cli-basics.md §3.6）并核对落盘
python3 -c "import json;print(json.load(open('<sessionDir>/state.json'))['lastPrompt'][:60])"
```

**成功判据**（三条同时满足才算送达）：`state.json.lastPrompt` == 你发的内容；`wire.jsonl` mtime 更新；屏幕出现 `⠹ thinking…`。

### 1.5 kimi TUI 界面字样（读屏判断用）

| 字样 | 含义 |
|---|---|
| `⠹ thinking…` / `⠸ Thinking…` | 正在跑 |
| `│ >  │`（空） | **空闲，等输入** |
| `❯ <文本>` + `↑ to edit · ctrl-s to steer immediately` | **排队中的消息**（回合结束才消费）—— 也是 cli-basics.md §3.6 残留行的形态 |
| footer `Never Ask  K3 thinking: high  <cwd>  <branch> [+85 -2 ↑39]` | 审批模式 / 模型 / 思考档 / cwd / 分支 / 改动量 / **未推送提交数**；含 `plan` = **Plan mode 开** |
| `context: 48% (491k/1M)` | 上下文占用（决定何时触发压缩） |
| `Todo` 面板 `✓` / `●` / `○` | agent 自己的任务清单（完成 / 进行中 / 待办） |
| `… +3 more (3 pending) · ctrl+t to expand` | Todo 折叠项 |
| `✨ <文本>` | 已投递的用户消息回显 |

### 1.6 与 pi 的关键差异

| 项 | pi（pi.md §1–pi.md pi.md §1，锁屏实测） | kimi（本次，未锁屏） |
|---|---|---|
| `send-key enter` | ⚠️ 间歇 15.5 s 超时 | ✅ 返回 OK 且**真的提交** |
| `send-key` 组合键 | `send-key "1"` 无效 | `control-u`/`ctrl-u`/`cmd-k`/`option-up`/`shift-tab` 均接受；`C-u` 不接受 |
| `read-screen` | ⚠️ 间歇超时 | ✅ 连续可用（0.1–11 s） |
| 多行投递 | 单行 `send '文本\r'` | `paste-buffer` + `Enter`（**注意残留行**） |
| 排队语义 | `Steering: <文本>` + `↳ Option+Up to edit all queued messages` | `❯ <文本>` + `↑ to edit · ctrl-s to steer immediately` |
| Plan / Goal 模式 | `▶ Goal … ACTIVE` / `⏸ Goal … STOPPED` | footer `plan` 字样；`Shift+Tab` 切换（**疑似**） |
| session 判定文件 | `~/.pi/agent/sessions/--<cwd转义>--/<ISO>_<uuid>.jsonl`（逐行 JSONL） | `<sessionDir>/state.json` + `agents/main/wire.jsonl`（**事件流**，按 `type` 解析） |
| session 路径规则 | cwd 全路径转义（`-` 连接） | **cwd 的 basename 小写 + hex**（§1.1）；用 `session_index.jsonl` 最稳 |

### 1.7 注意事项

1. **面板标题 ≠ 当前任务**：cmux 面板标题取自会话标题（最初目标，可跨天不变）⇒ 用它判断"它没在动"会误判；要看 `state.json.lastPrompt` 或 `wire.jsonl`。
2. **`state.json.updatedAt` 不等于活跃度**，只看 `wire.jsonl` mtime。
3. **投递后必须查残留行**（cli-basics.md §3.6），否则下一回合收到重复指令。
4. **探键不要盲打**（cli-basics.md §3.5）。
5. `wire.jsonl` 体量大（实测 14 MB+、1 万+ 行）⇒ **只读尾部 250–500 行**，别整文件解析。
6. 其中的文本是 **JSON 转义**的，取出后需再解一次（`json.loads('"'+raw+'"')`），否则中文乱码。

---

