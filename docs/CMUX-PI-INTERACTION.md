# cmux × pi 交互手册（从 bridge 远程驱动 cmux / pi）

> 整理时间：2026-09-27 ｜ 实测环境：macOS（darwin 27.0.0 / arm64，16 核）、cmux `0.64.25 (106)`、pi `0.87.0`、omp `18.2.11`
> **本文全部结论来自本机实测**（命令 + 输出）；未实测的标注 `[未验证]`。
> 适用场景：**电脑锁屏 / 无人值守时，从飞书（经 feishu-omp-bridge）或任意外部进程驱动 cmux 里的 pi 会话。**

---

## 0. TL;DR

| 你要做的事 | 正确命令 | 别用 |
|---|---|---|
| 发文本给 pi TUI | `cmux send --surface <ref> "文本"` | — |
| **发 Enter** | `cmux send --surface <ref> '\r'` | ❌ `send-key enter`（锁屏时 15.5s 超时） |
| **多选**切换 | `cmux send --surface <ref> " "` | ❌ `send-key space`（返回 OK 但**无效果**） |
| **单选**（数字键） | `cmux send --surface <ref> "1"` + `'\r'` | ❌ `send-key "1"`（`invalid_params: Unknown key`） |
| 一步完成「文本+Enter」 | `cmux send --surface <ref> '文本\r'` | ❌ `'\n'`（pi 输入框可能不提交） |
| 读屏幕 | `cmux read-screen --surface <ref> --lines N`（**可能超时**） | — |
| **读屏幕（锁屏稳）** | **读 pi 的 session JSONL** ✅ | ❌ 依赖 `read-screen` |
| 定位目标 | `cmux tree --all --json` / `cmux identify --json` | — |

> **三条铁律**：① **只用 `send`（文本通道），不用 `send-key`**；② **Enter 用 `'\r'`**；③ **验证读 session，不读屏**。

---

## 1. ★★ 权限与前置条件（**必做**）

### 1.1 cmux 侧：唯一必须开的是 **Socket Control Mode → `Automation`**

**这是 cmux App 自己的设置，不是 macOS 隐私权限。**

#### 为什么必须开

cmux 默认 `socketControlMode = cmuxOnly`，含义（取自 cmux 二进制里的官方文案）：

> *"Only processes started inside cmux terminals can send commands."*

而 bridge / 任何 launchd 拉起的进程链是 `node(bridge) ← launchd(1)`，**不在 cmux 内** ⇒ 直接被拒：

```bash
$ cmux ping
Error: ERROR: 访问被拒绝 - 只有在 cmux 内启动的进程才能连接
```

#### 九种模式对照（均取自 cmux 二进制文案）

| 值 | 文案 / 含义 | 适用 |
|---|---|---|
| `off` | 关闭 socket | — |
| `cmuxOnly`（**默认**） | *Only processes started inside cmux terminals can send commands.* | 最保守 |
| **`automation`** ⭐ | *Allow external local automation clients from this **macOS user** (no ancestry check).* | **本场景正解** |
| `password` | 需密码（配 `socketPassword`）；未配则报 *"Password mode is enabled but no socket password is configured in Settings."* | 需鉴权时 |
| **`allowAll`** | *Allow any local process and user to connect with no auth. **Unsafe**.* | 不建议 |
| `openAccess` / `fullOpenAccess` / `full` | legacy aliases（等价于 allowAll 系列） | 不建议 |
| `notifications` | 仅通知类 | — |

#### 怎么改（两种，任选其一）

**方式 A：GUI（推荐给人工操作）**
```
cmux → Settings → Automation → Socket Control Mode → 选 "Automation"
```

**方式 B：写配置文件**
```jsonc
// ~/.config/cmux/cmux.json
{
  "$schema": "https://raw.githubusercontent.com/manaflow-ai/cmux/main/web/data/cmux.schema.json",
  "schemaVersion": 1,
  "automation": { "socketControlMode": "automation" }
}
```
```bash
cmux reload-config      # 重载（无需重启 App）
```

#### ⚠️ 一个容易困惑的点：**GUI 改完，`cmux.json` 不会变**

cmux 配置分**两层**：

| 层 | 路径 | 角色 |
|---|---|---|
| **GUI 保存层** | `~/Library/Preferences/com.cmuxterm.app.plist` | **GUI Settings 写这里** |
| **file override 层** | `~/.config/cmux/cmux.json` | **只有显式写入的键才覆盖 GUI** |

> 官方文档原话：*"Remove a setting to fall back to the value saved in Settings."*

**⇒ 「在 GUI 里配好了，但 `cmux.json` 没变」是正常现象，配置已生效。**

#### 验证是否生效

```bash
# 1) 看落盘的设置值
defaults read com.cmuxterm.app | grep socketControlMode
#    期望：socketControlMode = automation;

# 2) 从【外部进程】（如 bridge 上下文）试连通
cmux ping
#    期望：PONG            （此前是「访问被拒绝」）

# 3) 再试一次真实读取
cmux identify --json
```

#### 安全权衡（开放前请知悉）

| 模式 | 谁能连 | 风险 |
|---|---|---|
| `cmuxOnly` | cmux 内进程 | 最低 |
| **`automation`** ⭐ | **同一 macOS 用户的任意本地进程** | 中 |
| `password` | 持密码者 | 中（密码泄露即全开） |
| `allowAll` | 任意本地进程与用户 | **高（官方标注 Unsafe）** |

**风险实质**：开放后，任何以该用户身份运行的进程都能 `cmux send` 到任意 terminal ⇒ **等价于「向任意 shell 注入命令 + 回车」**。单用户机器上的边际风险主要来自**误用 / 供应链攻击**（某个依赖偷偷调用 `cmux send`）。
**更保守的替代**：① `password` 模式 + 密码放进调用方的环境变量（`CMUX_SOCKET_PASSWORD`）；② 保持 `cmuxOnly`，让调用方**从 cmux 内启动**；③ **改走 tmux**（无访问控制，且 cmux 原生支持 `local-tmux`，会话可扛 cmux 崩溃）。

#### ⚠️ 不要尝试「伪造 PATH 拿身份」

cmux 通过向每个 workspace 注入 `PATH=/var/folders/.../cmux-cli-shims/<UUID>:...` 标记进程身份。
**该 UUID 目录是动态轮换的**（实测 3 分钟内从 `4EBD9E55-…` 变为 `CE815AEC-…`，旧目录随即被删）⇒ **靠改 PATH 冒充「cmux 内进程」不可行**，只能走 `socketControlMode`。

### 1.2 cmux 侧的 **macOS 隐私权限：不需要**（本场景）

| 操作 | 走什么通道 | 需要 TCC 权限？ |
|---|---|---|
| socket 通信（`ping` / `send` / `read-screen` / `tree` …） | **本机 Unix domain socket** | **❌ 不需要**（同用户本机通信不走 TCC） |
| `send`（文本注入） | 写入 cmux 自己终端的 pty | **❌ 不需要** |
| `read-screen` / `capture-pane` | 读 cmux **自己**的窗口内容 | **❌ 不需要**（非「屏幕录制」语义） |
| **`send-key`（注入按键）** | 可能是 GUI 事件路径 | **`[未验证]`** —— cmux 二进制里含大量 `Accessibility` 字符串，若发现按键注入无效，可考虑给 cmux 授予**辅助功能 / 辅助访问**权限 |
| **Computer Use / CUA（读其它 App、点击）** | 系统级自动化 | **需要**「辅助功能」+ 视情况「屏幕录制」；**本手册不依赖此能力** |

**相关设置**（cmux 内，默认已开，本场景**不需要**动）：
```jsonc
// computerUse.enabled 默认 true
// 描述：“Allow supported agent launches in cmux terminals to attach the local computer-use tools.”
// ⇒ 这是给【cmux 内】启动的 agent 用的，【外部进程不需要】
```

### 1.3 bridge 侧：macOS 15+ 的**「本地网络」**权限（与本手册相关但独立）

与本手册的 cmux 链路**无关**，但会影响 bridge 里执行的命令访问内网：

- macOS 15+ 的**本地网络隐私按进程身份放行**；由 launchd 直接拉起的 `node` 属于后台 CLI，**既弹不出授权框、也不会出现在「设置 → 隐私与安全性 → 本地网络」列表里**。
- 症状：bridge 里访问**同网段**地址（公司内网 FTP / 局域网服务）被内核拒绝，报 `No route to host`（Python 侧 `[Errno 65]`），而同一命令在终端里正常。
- 现成机制（见本仓库 `README.md` 与 `src/daemon/macos-supervisor.ts`）：先用 `xcrun swiftc` 编译并 `codesign` 一个 supervisor app（`~/.feishu-omp-bridge/macos/FeishuOmpBridge.app`），由它把 `node` 作为子进程运行 ⇒ 整棵进程树归到 `ai.feishu-omp-bridge.supervisor` 这个 app 身份 ⇒ 只弹**一次**授权框。
- 授权成功后写入 marker；**若权限被系统收回，删 marker 再 `restart` 重新触发**：
  ```bash
  # 授权 marker（存在=已授权）
  ls -la ~/.feishu-omp-bridge/macos/local-network-granted
  # 重新触发授权
  rm -f ~/.feishu-omp-bridge/macos/local-network-granted
  feishu-omp-bridge restart      # 或对应的 start/restart 命令
  ```

### 1.4 前置条件清单（照抄）

```
[ ] cmux 正在运行（GUI App，属主 = 当前登录用户）
[ ] cmux: Settings → Automation → Socket Control Mode = Automation
[ ] 验证：defaults read com.cmuxterm.app | grep socketControlMode  → automation
[ ] 验证：从外部进程执行 cmux ping                                → PONG
[ ] （锁屏场景）pmset -g 确认 sleep 未被系统睡眠中断（sleep 0 / prevented by …）
[ ] 知悉：send-key 不可靠，一律用 send（见 §3）
```

---

## 2. cmux 是什么 / 常用命令

```bash
$ which cmux
/Applications/cmux.app/Contents/Resources/bin/cmux        # 亦有 /opt/homebrew/bin/cmux
$ cmux --version
cmux 0.64.25 (106) [b685a275c]
```

- **终端多路复用器 App**（GUI，底层 Ghostty），通过 **Unix socket** 接受 CLI 控制。
- 层级：`window → workspace → pane → surface`（surface = terminal / browser / markdown / …）。
- socket 路径：`~/.local/state/cmux/cmux.sock`（`--socket` / `CMUX_SOCKET_PATH` 可覆盖）。

| 类别 | 命令 |
|---|---|
| **输入** | `send [--surface X] <text>`、`send-key`、`send-panel`、`send-key-panel` |
| **读取** | `read-screen [--lines N] [--scrollback]`、`read-selection`、`capture-pane`、`clear-history` |
| **定位** | `identify --json`、`tree --all --json`、`list-windows`、`list-workspaces`、`current-window` |
| **创建** | `new-workspace --cwd <path> --command <text>`、`new-pane`、`new-surface`、`new-split`、`open <path>` |
| **编排** | `events`（事件流）、`rpc <method> [json]`、`notify`、`set-status`、`set-progress` |
| **tmux** | `local-tmux <start\|attach\|list\|status\|detach\|close\|cleanup>`、`tmux attach` |
| **其它** | `ping`、`diff`、`config doctor/check/reload-config`、`browser ...`、`vault ...` |

**`send` 的转义**（help 原文）：**`\n` 与 `\r` 发 Enter，`\t` 发 Tab**。

---

## 3. ★★ 锁屏（无 GUI 交互）下的能力矩阵

**环境实测**：`pmset -g` ⇒ `sleep 0 (sleep prevented by bun, coreaudiod)`、`displaysleep 5`、`standby 0` ⇒ **系统不睡眠，cmux / pi 进程继续存活**。

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

### 3.1 踩坑清单（都实际踩到）

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

## 4. ★ pi 与 omp 是两个不同的东西

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

### 4.1 rpc frame 协议高度兼容（实测两包的 `dist/modes/rpc/rpc-mode.js`、`agent-session.js`）

| frame | pi | omp |
|---|---|---|
| `ready` / `response` / `message_update` | ✅ | ✅ |
| `tool_execution_start/update/end` | ✅ | ✅ |
| `turn_end` / `agent_end` / `extension_ui_request` | ✅ | ✅ |
| `notice` / `subagent_lifecycle` | ❌ | ✅（pi 不发 ⇒ 无害） |

### 4.2 session 文件位置规则

```
~/.pi/agent/sessions/--<cwd 转义>--/<ISO时间>_<uuid>.jsonl

例：cwd=/Users/tbd/Git/FutuClient1
 → ~/.pi/agent/sessions/--Users-tbd-Git-FutuClient1--/2026-09-23T12-29-26-471Z_01a0ce3e-….jsonl
    cwd=/Users/tbd
 → ~/.pi/agent/sessions/--Users-tbd--/….jsonl
```

**行数 / mtime 是最可靠的「是否在推进」指标。**

---

## 5. ★★ 向 pi TUI 投递消息的语义

### 5.1 两种结果：**直接提交** vs **进 Steering 队列**

| 目标当时状态 | 结果 | 观测方式 |
|---|---|---|
| **idle**（等输入） | **直接提交进 session**，立即生效 | session 新增 `role: user` 行 |
| **busy**（有运行中任务 / BG 作业） | 屏幕出现 `Steering: <文本>` + `↳ Option+Up to edit all queued messages`，**待当前 turn 结束才消费** | session 暂不增长 |

**⇒ 「发完没反应」通常是【排队】，不是失败。**
**⇒ 要让 busy 目标立刻看到，只能中断其当前任务（不推荐，会打断构建）。**

### 5.2 pi TUI 界面元素（读屏时用于判断状态）

```
▶ Goal 1/1 · ACTIVE · round 178 · 69h27m · Option+G details      ← Goal 运行中
⏸ Goal 1/1 · STOPPED · round 178 · 69h19m · /goal resume · …     ← Goal 暂停（恢复：/goal resume）
● 继续任务，直到完成目标 · active ／ ‖ 继续任务… · paused          ← Goal 一句话状态
YOLO · ⚡ <model> · <thinking> · <cwd> · <branch> · [███░░░░░] 16% · 159k/1m · ↑6.9m · ↓2.4m · $5.95
⠋ · BG · 1 running · 3m 30s · Option+J details                    ← 后台作业
Steering: <文本>                                                   ← 排队中的引导消息
Esc 取消 · Enter 选择/确认 · →/Tab 跳过 · ↑↓ 移动 · 空格 切换 · …  ← 交互式对话框键位提示
```

### 5.3 `ask-user-question` 类交互对话框

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

## 6. 标准操作手册

### 6.1 定位目标

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

### 6.2 发消息（推荐姿势）

```bash
S=surface:1
cmux send --surface "$S" '你的消息\r'      # 文本 + 回车，一步到位
sleep 3                                    # 等几秒再验证
```

### 6.3 验证（**不依赖读屏**）

```bash
# A) 定位 session（TUI 标题里常带 session 前缀，如 "✳ pi · 01a0e12c · WAITING FOR INPUT"）
ls -t ~/.pi/agent/sessions/--Users-tbd-Git-FutuClient1--/*.jsonl | head -1

# B) 是否推进（行数 / mtime）
f=$(ls -t ~/.pi/agent/sessions/--Users-tbd-Git-FutuClient1--/*.jsonl | head -1)
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

### 6.4 常用 session 事件速查

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

## 7. 端到端验证案例（本次实测）

**目标**：`surface:6`（cwd=`~`）上 pi 正在跑 `ask-user-question`（3 问），验证「能否从外部正常回答」。

```bash
S=surface:6
cmux send --surface $S "1";                    cmux send --surface $S '\r'   # 单选：第 1 项
cmux send --surface $S " ";                    cmux send --surface $S '\r'   # 多选：切换第 1 项
cmux send --surface $S "cmux 外部注入测试 OK"; cmux send --surface $S '\r'   # 自由输入
cmux send --surface $S '\r'                                                  # 提交
```

**结果（session 落盘证据）**：
```
[04:52:13Z] toolResult ask-user-question: Collected 3 answers.
  1. 单选测试：你希望接下来我做什么？            → 继续闲聊
  2. 多选测试：你平时常用的功能有哪些？           → 代码搜索/阅读
  3. 自由输入测试：随便打点什么…                 → cmux 外部注入测试 OK
  { "answers": [ {"selected":["继续闲聊"]}, {"selected":["代码搜索/阅读"]},
                 {"header":"自由输入","selected":[],"text":"cmux 外部注入测试 OK"} ] }
```
- session **6 → 8 行**；
- pi 自己回：*「结论：`ask-user-question` 的选项选择、多选、自由文本三条路径都通，结构化返回（`answers[]` + `selected`/`text`）也完整。」*

**⇒ 锁屏 + 外部进程 条件下，通过 `cmux send` 完整回答 pi 的交互式提问是可行的。**

---

## 8. 环境与运维备忘

| 项 | 实测值 |
|---|---|
| cmux 进程 | `/Applications/cmux.app/Contents/MacOS/cmux`，属主 = 登录用户（本机 `tbd`, uid 502） |
| cmux 启动方式 | 普通 GUI App（**非** launchd agent） |
| **睡眠** | `pmset -g`：`sleep 0 (sleep prevented by bun, coreaudiod)`、`displaysleep 5`、`standby 0` ⇒ **锁屏不睡眠** |
| 登录用户 / GUI 域 | `/dev/console` 属主 = `tbd`；launchd `gui/502` |
| bridge 托管 | launchd `ai.feishu-omp-bridge.bot`（+ `.heal`），`KeepAlive=true` |
| 模拟器 | `xcrun simctl list devices booted` 可查（锁屏不阻断模拟器） |
| **风险提示** | 多 workspace 并发构建时系统 load 可达 **400+（16 核）**，此时 cmux 命令普遍超时；磁盘亦会快速消耗（实测 25 min −80 GiB，随后稳定） |

---

## 9. 尚未验证 / 待补

- [ ] `cmux events` 事件流驱动的**订阅式**自动化（替代轮询读屏）
- [ ] **`cmux local-tmux` 路线**：把长跑任务放进 tmux ⇒ **彻底绕开 cmux 权限与锁屏限制**
- [ ] `new-workspace --cwd --command` 从外部**创建**带 pi 的工作区
- [ ] 锁屏下 `new-*` / `events` / `rpc` 是否同样可用
- [ ] **pi 的 `--mode rpc` 直连方案**（相较 TUI 注入，不依赖 GUI，可能是更稳的长期路线）
- [ ] `send-key` 是否需要「辅助功能」权限（见 §1.2）
- [ ] `cmux notify` / `set-status` / `set-progress` 能否**反向**把 pi 状态推到 cmux UI

---

## 10. 一分钟上手（复制即用）

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
f=$(ls -t ~/.pi/agent/sessions/--Users-tbd-Git-FutuClient1--/*.jsonl | head -1)
wc -l "$f"; stat -f 'mtime %Sm' -t '%H:%M:%S' "$f"
```

> 记住三句话：**`send` 不用 `send-key`** ｜ **Enter 用 `\r`** ｜ **验证读 session 不读屏**。
