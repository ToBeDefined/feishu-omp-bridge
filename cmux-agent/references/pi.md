# pi（omp/pi-coding-agent）TUI 驱动：锁屏矩阵、session 验证、投递语义（§1–8）
> 章节号为本文件自编号（1 起）；跨文件引用写作「文件名 §x.y」。SKILL.md 主入口见 ../SKILL.md。

## 1. ★★ 锁屏（无 GUI 交互）下的能力矩阵


| 操作 | 命令 | 锁屏时 | 实测耗时 | 效果 |
|---|---|---|---|---|
| 轻量查询 | `ping` / `identify --json` / `list-*` | ✅ 可用 | 133 ms / 993 ms | — |
| **注入文本** | `cmux send --surface X "文本"` | ✅ **可用** | **57 ms** | ✅ 有效 |
| **注入空格** | `cmux send --surface X " "` | ✅ **可用** | — | ✅ **有效**（多选切换） |
| **注入 Enter** | `cmux send --surface X '\r'` | ✅ **可用** | **174 ms** | ✅ **有效** |
| 注入按键 | `cmux send-key` | ⚠️ **间歇 15.5 s 超时** | 15.5 s（曾成功 1.46 s） | ⚠️ 不可靠 |
| **读屏幕** | `read-screen` / `capture-pane` | ⚠️ **间歇超时**（0.2 s ~ >60 s 波动） | — | 可用但不可依赖 |
| 创建/编排 | `new-workspace` / `events` / `rpc` | `[未验证]` | — | — |

**⇒ 结论：锁屏下 `send`（文本通道）是唯一全可靠路径** —— 它直接写终端输入，既不注入 GUI 键盘事件，也不读窗口内容。

> **补充（未锁屏 + kimi）**：上表的可靠性结论**只在「锁屏」条件下成立**。未锁屏时实测
> `send-key Enter` / `send-key backspace` / `send-key Up` **均返回 OK 且真实生效**，`read-screen` 也连续可用（0.1–11 s 返回）；
> 组合键被接受的形式是 `control-u` / `ctrl-u` / `cmd-k` / `option-up` / `shift-x`（**`C-u` 这种缩写会被拒**）。
> 完整键名清单与两个新坑（`paste-buffer` 残留排队行、`shift-tab` 疑似 Plan mode 开关）见 **cli-basics.md §3**；kimi 的会话定位与判活见 **kimi.md §1**。

### 1.1 踩坑清单

| # | 坑 | 表现 | 正解 |
|---|---|---|---|
| 1 | `send-key space` | 返回 `OK` 但**多选无变化** | 改用 `send " "` |
| 2 | `send-key "1"` | `Error: invalid_params: Unknown key` | 改用 `send "1"` |
| 3 | `send-key enter` | 间歇 `Error: Command timed out`（15.5 s） | 改用 `send '\r'` |
| 4 | `send "...\n"` 提交 pi 输入框 | 文本进了框但**未提交** | 用 `'\r'`；仍不行再补 `send-key enter` |
| 5 | **命令报超时但操作已生效** | 以为失败，实际已送达 | **用 session 文件复核**，别只看返回值 |
| 6 | 把「超时」误判为「权限被拒」 | 与 `访问被拒绝` 混淆 | 区分：**拒绝=权限**；**超时=锁屏/负载** |
| 7 | 锁屏时死磕读屏 | 拿不到画面就无法推进 | 一切验证走 **session JSONL** |

---

## 2. ★ pi 与 omp 是两个不同的东西

| | **pi** | **omp** |
|---|---|---|
| npm 包 | `@earendil-works/pi-coding-agent` | `@oh-my-pi/pi-coding-agent` |
| 版本（实测） | **0.87.0** | **18.2.11** |
| 可执行 | `~/.bun/bin/pi` | `~/.bun/bin/omp` |
| agentDir | `~/.pi/agent/` | `~/.omp/agent/` |
| session 目录 | `~/.pi/agent/sessions/` | `~/.omp/agent/sessions/`（或 `--session-dir`） |
| rpc 模式 | ✅ `--mode rpc` | ✅ `--mode rpc` |
| 独有参数 | — | `--no-title` |

**⇒ 本仓库（feishu-omp-bridge）默认驱动 `omp`；若要驱动 `pi`**，配置层面主要需：`binary` 换成 `pi`、`sessionDir` 指向 pi 的目录、并处理 `--no-title`（pi 不认该参数）。

### 2.1 rpc frame 协议高度兼容（实测两包的 `dist/modes/rpc/rpc-mode.js`、`agent-session.js`）

| frame | pi | omp |
|---|---|---|
| `ready` / `response` / `message_update` | ✅ | ✅ |
| `tool_execution_start/update/end` | ✅ | ✅ |
| `turn_end` / `agent_end` / `extension_ui_request` | ✅ | ✅ |
| `notice` / `subagent_lifecycle` | ❌ | ✅（pi 不发 ⇒ 无害） |

### 2.2 session 文件位置规则

```
~/.pi/agent/sessions/--<cwd 转义>--/<ISO时间>_<uuid>.jsonl

例：cwd=~/projects/demo-repo
 → ~/.pi/agent/sessions/--Users-<短用户名>-projects-demo-repo--/2026-09-23T12-29-26-471Z_<uuid>.jsonl
    cwd=~
 → ~/.pi/agent/sessions/--Users-<短用户名>--/….jsonl

（`<短用户名>` 为 macOS 账户短名；完整规则：将 cwd 绝对路径去掉首字符 `/` 后把 `/` 换成 `-`。）
```

**行数 / mtime 是最可靠的「是否在推进」指标。**

---

## 3. ★★ 向 pi TUI 投递消息的语义

### 3.1 两种结果：**直接提交** vs **进 Steering 队列**

| 目标当时状态 | 结果 | 观测方式 |
|---|---|---|
| **idle**（等输入） | **直接提交进 session**，立即生效 | session 新增 `role: user` 行 |
| **busy**（有运行中任务 / BG 作业） | 屏幕出现 `Steering: <文本>` + `↳ Option+Up to edit all queued messages`，**待当前 turn 结束才消费** | session 暂不增长 |

**⇒ 「发完没反应」通常是【排队】，不是失败。**
**⇒ 要让 busy 目标立刻看到，只能中断其当前任务（不推荐，会打断构建）。**

### 3.2 pi TUI 界面元素（读屏时用于判断状态）

```
▶ Goal 1/1 · ACTIVE · round 178 · 69h27m · Option+G details      ← Goal 运行中
⏸ Goal 1/1 · STOPPED · round 178 · 69h19m · /goal resume · …     ← Goal 暂停（恢复：/goal resume）
● 继续任务，直到完成目标 · active ／ ‖ 继续任务… · paused          ← Goal 一句话状态
YOLO · ⚡ <model> · <thinking> · <cwd> · <branch> · [███░░░░░] 16% · 159k/1m · ↑6.9m · ↓2.4m · $5.95
⠋ · BG · 1 running · 3m 30s · Option+J details                    ← 后台作业
Steering: <文本>                                                   ← 排队中的引导消息
Esc 取消 · Enter 选择/确认 · →/Tab 跳过 · ↑↓ 移动 · 空格 切换 · …  ← 交互式对话框键位提示
```

### 3.3 `ask-user-question` 类交互对话框

```
询问用户 ·  ✓单选  >  多选  >  自由输入  >  提交          ← 步骤条（完成打 ✓）
单选测试：你希望接下来我做什么？                          ← 问题
单选 · 数字键选择 · 可附说明 · 未选择（可 →/Tab 跳过）      ← 类型/操作提示
› 1. 继续闲聊          ┌─ 预览 ─┐
  2. 检查某个项目       │ …      │
Esc 取消 · Enter 选择/确认 · →/Tab 跳过 · ↑↓ 移动 · 1-9 选择 · d 附加说明 · PgN/Shift+↓ 滚动
```

**驱动方式（实测全部有效）**：

| 类型 | 操作 |
|---|---|
| 单选 | `send "1"` → `send '\r'` |
| **多选** | `send " "`（切换当前项）→ `send '\r'` |
| 自由输入 | `send "<文本>"` → `send '\r'` |
| 提交 | `send '\r'` |

---

## 4. 标准操作手册

### 4.1 定位目标

```bash
cmux tree --all --json | python3 -c "
import sys,json
d=json.load(sys.stdin)
for w in d['windows']:
  for ws in w['workspaces']:
    for p in ws['panes']:
      for s in (p.get('surfaces') or []):
        print(ws['ref'], s['ref'], s['type'], repr(s.get('title')), 'tty=', s.get('tty'))
"
```

### 4.2 发消息（推荐姿势）

```bash
S=surface:1
cmux send --surface "$S" '你的消息\r'      # 文本 + 回车，一步到位
sleep 3                                    # 等几秒再验证
```

### 4.3 验证（**不依赖读屏**）

```bash
# A) 定位 session（TUI 标题里常带 session 前缀，如 "✳ pi · 01a0e12c · WAITING FOR INPUT"）
#    目录名按 §2.2 由工作目录推导，示例：
PI_SESSION_GLOB=~/.pi/agent/sessions/--Users-$(whoami)-projects-demo-repo--/*.jsonl
ls -t $PI_SESSION_GLOB | head -1

# B) 是否推进（行数 / mtime）
f=$(ls -t $PI_SESSION_GLOB | head -1)
wc -l "$f"; stat -f '%Sm' -t '%H:%M:%S' "$f"

# C) 最后几条事件
python3 - "$f" <<'PY'
import json,sys
for l in open(sys.argv[1],encoding="utf-8",errors="replace").readlines()[-6:]:
    e=json.loads(l)
    if e.get("type")=="message":
        m=e["message"]; c=m.get("content")
        s=" ".join(y.get("text","") for y in c if isinstance(y,dict) and y.get("type") in (None,"text")) if isinstance(c,list) else str(c)
        print(e["timestamp"][11:19], m.get("role"), m.get("toolName") or "", " ".join(s.split())[:200])
    else:
        print(e.get("timestamp","")[11:19], e.get("type"), e.get("customType") or "")
PY
```

### 4.4 常用 session 事件速查

| 事件 | 含义 |
|---|---|
| `{"type":"session","cwd":…}` | 会话头（首行） |
| `type: message, role: user/assistant/toolResult` | 对话 |
| `customType: goal-state` | **Goal 状态**（`status` / `iteration` / `tokensUsed` / `timeUsedSeconds`） |
| `customType: maestro-goal-internal` | 目标推进的内部注入（含 "keep working, do not summarize"） |
| `customType: todo-content` / `todo-state` | TODO 清单与状态 |
| `toolResult ask-user-question` | `ask` 的结构化返回（`answers[]` + `selected` / `text`） |
| `type: compaction` | 上下文压缩（含 `summary`） |

---

## 5. 回答交互式提问（ask-user-question）速查

```bash
S=surface:6
cmux send --surface $S "1";                    cmux send --surface $S '\r'   # 单选：第 1 项
cmux send --surface $S " ";                    cmux send --surface $S '\r'   # 多选：切换第 1 项
cmux send --surface $S "自由文本内容";           cmux send --surface $S '\r'   # 自由输入
cmux send --surface $S '\r'                                                  # 提交
```

单选/多选/自由文本三条路径均可锁屏远程作答，结构化 `answers[]` 完整落盘 session。

---


## 6. 环境与运维备忘

| 项 | 实测值 |
|---|---|
| cmux 进程 | `/Applications/cmux.app/Contents/MacOS/cmux`，属主 = 当前 macOS 登录用户 |
| cmux 启动方式 | 普通 GUI App（**非** launchd agent） |
| **睡眠** | `pmset -g`：`sleep 0 (sleep prevented by bun, coreaudiod)`、`displaysleep 5`、`standby 0` ⇒ **锁屏不睡眠** |
| 登录用户 / GUI 域 | `/dev/console` 属主 = 当前登录用户；launchd `gui/<uid>`（`id -u` 可查） |
| bridge 托管 | launchd `ai.feishu-omp-bridge.bot`（+ `.heal`），`KeepAlive=true` |
| 模拟器 | `xcrun simctl list devices booted` 可查（锁屏不阻断模拟器） |
| **风险提示** | 多 workspace 并发构建时系统 load 可达 **400+（16 核）**，此时 cmux 命令普遍超时；磁盘亦会快速消耗（实测 25 min −80 GiB，随后稳定） |

---

## 7. 尚未验证 / 待补

- [ ] `cmux events` 事件流驱动的**订阅式**自动化（替代轮询读屏）
- [ ] **`cmux local-tmux` 路线**：把长跑任务放进 tmux ⇒ **彻底绕开 cmux 权限与锁屏限制**
- [ ] `new-workspace --cwd --command` 从外部**创建**带 pi 的工作区
- [ ] 锁屏下 `new-*` / `events` / `rpc` 是否同样可用
- [ ] **pi 的 `--mode rpc` 直连方案**（相较 TUI 注入，不依赖 GUI，可能是更稳的长期路线）
- [ ] `cmux notify` / `set-status` / `set-progress` 能否**反向**把 pi 状态推到 cmux UI

- [ ] 锁屏下 `paste-buffer` 是否仍可靠
- [ ] `paste-buffer` **残留排队行**的成因与更稳替代（如 `send` 分段 + `\r` 逐段提交）
- [ ] **`shift-tab` = kimi Plan mode 开关**的因果隔离（本次是批量探键时误触，未逐一隔离）
- [ ] kimi 是否也有类似 pi `--mode rpc` 的**非 TUI 通道**（有 `~/.kimi-code/server` + `server.token`，用途未探明）
- [ ] kimi 会话目录 hash 的生成规则（本次只按 basename 前缀匹配，`session_index.jsonl` 更可靠）
- [ ] **`cursor-agent -p` 端到端**：`--output-format text/json/stream-json` 的实际输出形状、退出码、错误码约定（本次只读了 `--help`）
- [ ] **`~/.cursor/chats/<hash>/<chatId>/store.db` 的完整解码**：二进制 blob 是内容寻址树节点（`meta.latestRootBlobId` 为根），重建整段对话的算法未做
- [ ] `cursor-agent persist`（断连存活会话）与 cmux 面板的对应关系：断开后如何重新定位/续接
- [ ] `~/.orca/agent-hooks` 的 `ORCA_AGENT_HOOK_PORT` / `ORCA_AGENT_HOOK_TOKEN` 生命周期（cmux 重启后是否轮换；外部进程能否复用该端点主动推通知）
- [ ] Cursor 面板的 `Cursor is waiting for you` 具体由哪个 hook 事件触发（`afterAgentResponse` 还是 `beforeSubmitPrompt`）

---

## 8. 一分钟上手（复制即用）

```bash
# 0) 一次性开启 cmux 权限
#    GUI: Settings → Automation → Socket Control Mode → Automation
defaults read com.cmuxterm.app | grep socketControlMode     # 应输出 = automation;
cmux ping                                                   # 应输出 PONG

# 1) 找目标 surface
cmux tree --all --json | head -c 2000

# 2) 发消息（只用 send；Enter 用 \r）
cmux send --surface surface:1 '你的指令\r'

# 3) 用 session 文件验证（锁屏也可用）
f=$(ls -t ~/.pi/agent/sessions/--Users-$(whoami)-projects-demo-repo--/*.jsonl | head -1)
wc -l "$f"; stat -f 'mtime %Sm' -t '%H:%M:%S' "$f"
```

> 记住三句话（pi）：**`send` 不用 `send-key`** ｜ **Enter 用 `\r`** ｜ **验证读 session 不读屏**。
>
> 记住三句话（kimi，未锁屏）：**投递用 `paste-buffer` + `send-key Enter`** ｜ **投递后必清残留行（`Up` + `backspace`）** ｜ **验证读 `state.json` / `wire.jsonl`**。
>
> 记住三句话（Cursor）：**有非交互通道就优先 `cursor-agent -p`** ｜ **会话在 `~/.cursor/chats/<hash>/<chatId>/store.db`（SQLite），判活看 mtime/size** ｜ **走 TUI 注入时同样要清残留行**。

---

