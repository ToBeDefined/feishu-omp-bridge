# cmux × agent TUI 交互手册（pi / kimi / Cursor，从 bridge 远程驱动）

> 整理时间：2026-09-27（pi）｜ 补充：2026-09-29（kimi、Cursor、cmux CLI 与 hook 通知机制，见 **§11 ~ §14**）
> 实测环境：macOS（darwin 27.0.0 / arm64，16 核）、cmux `0.64.25 (106)`、pi `0.87.0`、omp `18.2.11`、kimi（Kimi Code）`~/.kimi-code/bin/kimi`、Cursor Agent CLI `cursor-agent 2026.09.28-64d2043`
> **本文全部结论来自本机实测**（命令 + 输出）；未实测的标注 `[未验证]`。
> 适用场景：**电脑锁屏 / 无人值守时，从飞书（经 feishu-omp-bridge）或任意外部进程驱动 cmux 里的 agent 会话（pi / kimi / Cursor）。**
>
> 阅读顺序：§0–§10 是 **pi** 场景（锁屏能力矩阵、`send` vs `send-key`）；**§11 cmux CLI 通用补充**（定位/键名/`paste-buffer` 残留行坑）；**§12 kimi（Kimi Code）驱动**；**§13 Cursor（cursor-agent）驱动**；**§14 agent 通知机制**（`~/.orca/agent-hooks` ⇄ cmux 通知，解释「Cursor is waiting for you」「Kimi Code task complete」从哪来）。

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

### 0.1 kimi（Kimi Code）场景速查（2026-09-29 实测，未锁屏）

| 你要做的事 | 正确命令 | 别用 |
|---|---|---|
| 定位目标 | `cmux list-workspaces` → `cmux list-panels --workspace <ws>` 取 `surface:<n>` | ❌ 硬编码 `workspace:4`（**编号会跳号**，实测同一时刻存在 1,2,3,4,**7**,8,9,10） |
| **投递多行/长消息** | `cmux set-buffer --name X '<文本>'` → `cmux paste-buffer --name X --workspace <ws>` → `cmux send-key <ws> Enter` | ❌ 逐行 `send`（会分段提交） |
| **提交** | `cmux send-key --workspace <ws> Enter` ✅（kimi 上返回 OK 且**真的提交**） | — |
| 清空输入框 | `cmux send-key <ws> backspace` ×N（实测 220 次清空两行） | ❌ `send-key C-u`（`invalid_params: Unknown key`；要写 `control-u`/`ctrl-u`） |
| 清理**残留排队行** | `send-key <ws> Up`（= 界面提示 "↑ to edit"）→ `backspace` ×N | ❌ 不管它（回合结束会**再投一次**，变成重复指令） |
| 判活 / 判"最后收到什么指令" | `<sessionDir>/state.json` 的 `updatedAt` / `lastPrompt` + `agents/main/wire.jsonl` 的 mtime+size | ❌ 只看 `read-screen` |
| 一次读全部窗口状态 | `~/Library/Application Support/cmux/session-com.cmuxterm.app.json`（windows→workspaces→panels + notifications） | ❌ 逐个 `read-screen` |
| 摸键名 | 二进制 `strings` 枚举 + `cmux rpc <method>`（缺参报错无副作用）；最小验证只对**空输入框**做 | ❌ 盲打组合键（`shift-tab` 疑似 kimi 的 **Plan mode 开关**，误触会改变行为） |

### 0.2 Cursor（cursor-agent）场景速查（2026-09-29 实测）

| 你要做的事 | 正确命令 | 别用 |
|---|---|---|
| 找可执行 | `~/.local/bin/agent`（→ `~/.local/share/cursor-agent/versions/<ver>/cursor-agent`），亦有 `~/.local/bin/cursor-agent` | ❌ `/usr/local/bin/cursor`（那是 **IDE CLI**，不是 agent） |
| **非交互驱动（推荐）** | `cursor-agent -p "<prompt>" --output-format json` | ❌ 只靠 TUI 注入（pi/kimi 才必须） |
| 续指定会话 | `cursor-agent --resume <chatId> -p "…"`（chatId 见下） | — |
| 新建会话拿 id | `cursor-agent create-chat` | — |
| 只读/不落改动 | `--mode plan`（纯规划）／`--mode ask`（仅问答）／`--sandbox enabled` | ⚠️ `-p` 默认**有全部工具权限（含 write/shell）** |
| 定位会话数据 | `~/.cursor/chats/<32hex>/<chatId>/store.db`（**SQLite**，非 JSONL） | ❌ 找 `*.jsonl`（不存在） |
| 判活 | `stat -f '%Sm %z'` 该 `store.db`（只读打开：`sqlite3 'file:…?mode=ro'`） | — |
| 读最近对话 | `select id, substr(cast(data as text),1,200) from blobs where substr(data,1,1)=X'7B' order by rowid desc limit 20`（`X'7B'` = `{`；**只有 JSON 类 blob 可读**） | ❌ `substr(data,1,1)='{'`（BLOB 与 TEXT 比较**恒不相等**，会返回 0 行）；❌ 把 `blobs` 全当文本读 |
| 看它是不是「在等你」 | cmux 通知：面板 `notifications[]` 里的 **`Cursor is waiting for you`**（§11.6 一次读全） | — |

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
**该 UUID 目录是动态轮换的**（实测数分钟内从 `<UUID-A>` 变为 `<UUID-B>`，旧目录随即被删）⇒ **靠改 PATH 冒充「cmux 内进程」不可行**，只能走 `socketControlMode`。

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
- 现成机制（见本仓库 `README.md` 与 `src/daemon/macos-supervisor.ts`）：先用 `xcrun swiftc` 编译并 `codesign` 一个 supervisor app（bridge 数据目录下的 `macos/FeishuOmpBridge.app`，默认在 `~/.feishu-omp-bridge/`），由它把 `node` 作为子进程运行 ⇒ 整棵进程树归到 `ai.feishu-omp-bridge.supervisor` 这个 app 身份 ⇒ 只弹**一次**授权框。
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

> **补充（2026-09-29，未锁屏 + kimi）**：上表的可靠性结论**只在「锁屏」条件下成立**。未锁屏时实测
> `send-key Enter` / `send-key backspace` / `send-key Up` **均返回 OK 且真实生效**，`read-screen` 也连续可用（0.1–11 s 返回）；
> 组合键被接受的形式是 `control-u` / `ctrl-u` / `cmd-k` / `option-up` / `shift-x`（**`C-u` 这种缩写会被拒**）。
> 完整键名清单与两个新坑（`paste-buffer` 残留排队行、`shift-tab` 疑似 Plan mode 开关）见 **§11**；kimi 的会话定位与判活见 **§12**。

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

例：cwd=~/projects/demo-repo
 → ~/.pi/agent/sessions/--Users-<短用户名>-projects-demo-repo--/2026-09-23T12-29-26-471Z_<uuid>.jsonl
    cwd=~
 → ~/.pi/agent/sessions/--Users-<短用户名>--/….jsonl

（`<短用户名>` 为 macOS 账户短名；完整规则：将 cwd 绝对路径去掉首字符 `/` 后把 `/` 换成 `-`。）
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
#    目录名按 §4.2 由工作目录推导，示例：
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
| cmux 进程 | `/Applications/cmux.app/Contents/MacOS/cmux`，属主 = 当前 macOS 登录用户 |
| cmux 启动方式 | 普通 GUI App（**非** launchd agent） |
| **睡眠** | `pmset -g`：`sleep 0 (sleep prevented by bun, coreaudiod)`、`displaysleep 5`、`standby 0` ⇒ **锁屏不睡眠** |
| 登录用户 / GUI 域 | `/dev/console` 属主 = 当前登录用户；launchd `gui/<uid>`（`id -u` 可查） |
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
- [x] ~~`send-key` 是否需要「辅助功能」权限（见 §1.2）~~ ⇒ **未锁屏场景不需要**：`send-key Enter/backspace/Up` 实测返回 OK 且生效（kimi，2026-09-29）；**锁屏场景仍 `[未验证]`**
- [ ] `cmux notify` / `set-status` / `set-progress` 能否**反向**把 pi 状态推到 cmux UI

**新增待验（2026-09-29，来自 §11 / §12 实测）**：

- [ ] **锁屏下对 kimi 的 `send-key` / `paste-buffer` 是否仍可靠**（本次全部为未锁屏实测）
- [ ] `paste-buffer` **残留排队行**的成因（是否与换行/终端宽度相关）与更稳的替代（如改用 `send` 分段 + `\r` 逐段提交）
- [ ] **`shift-tab` = kimi Plan mode 开关**的因果隔离（本次是批量探键时误触，未逐一隔离）
- [ ] kimi 是否也有类似 pi `--mode rpc` 的**非 TUI 通道**（有 `~/.kimi-code/server` + `server.token`，用途未探明）
- [ ] kimi 会话目录 hash 的生成规则（本次只按 basename 前缀匹配，`session_index.jsonl` 更可靠）
- [ ] **`cursor-agent -p` 端到端**：`--output-format text/json/stream-json` 的实际输出形状、退出码、错误码约定（本次只读了 `--help`）
- [ ] **`~/.cursor/chats/<hash>/<chatId>/store.db` 的完整解码**：二进制 blob 是内容寻址树节点（`meta.latestRootBlobId` 为根），重建整段对话的算法未做
- [ ] `cursor-agent persist`（断连存活会话）与 cmux 面板的对应关系：断开后如何重新定位/续接
- [ ] `~/.orca/agent-hooks` 的 `ORCA_AGENT_HOOK_PORT` / `ORCA_AGENT_HOOK_TOKEN` 生命周期（cmux 重启后是否轮换；外部进程能否复用该端点主动推通知）
- [ ] Cursor 面板的 `Cursor is waiting for you` 具体由哪个 hook 事件触发（`afterAgentResponse` 还是 `beforeSubmitPrompt`）

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
f=$(ls -t ~/.pi/agent/sessions/--Users-$(whoami)-projects-demo-repo--/*.jsonl | head -1)
wc -l "$f"; stat -f 'mtime %Sm' -t '%H:%M:%S' "$f"
```

> 记住三句话（pi）：**`send` 不用 `send-key`** ｜ **Enter 用 `\r`** ｜ **验证读 session 不读屏**。
>
> 记住三句话（kimi，未锁屏）：**投递用 `paste-buffer` + `send-key Enter`** ｜ **投递后必清残留行（`Up` + `backspace`）** ｜ **验证读 `state.json` / `wire.jsonl`**。
>
> 记住三句话（Cursor）：**有非交互通道就优先 `cursor-agent -p`** ｜ **会话在 `~/.cursor/chats/<hash>/<chatId>/store.db`（SQLite），判活看 mtime/size** ｜ **走 TUI 注入时同样要清残留行**。

---

## 11. cmux CLI 通用补充（2026-09-29 实测；未锁屏）

### 11.1 定位：workspace / pane / surface 的取法

```bash
cmux list-workspaces        # 别名 cmux workspace list；* = 当前选中
# 注：旧写法会打印 "…is now an alias for…" 提示，设 CMUX_QUIET=1 可静音
# * workspace:1  Proj-A: feature branch  [selected]
#   workspace:2  Proj-B: device tests
#   workspace:3  Proj-C: codegen
#   workspace:4  Proj-D: dependency bump
#   workspace:7  Debug: native attach        ← 注意：编号跳号（1,2,3,4,7,8,9,10）
cmux list-panels --workspace workspace:7
# * surface:7  terminal  [focused]  "示例面板标题（取自会话初始目标，不随当前动作变化）"
```

- **编号会跳号**（同一次实测里 5/6 不存在）⇒ **一律先 `list-workspaces` 拿 ref 再用 ref**，不要硬编码 `workspace:<n>`。
- `list-panels` 给出的标题是**会话/面板标题**，**不随当前动作变化** ⇒ 别用它判断"它现在在干什么"（见 §12.7-1）。

### 11.2 `read-screen` 在未锁屏下可用

```bash
cmux read-screen --workspace workspace:7 --lines 40     # 实测 0.1–11 s 返回，连续多次稳定
```

用途：判断目标状态（thinking / 空闲 / 有排队消息）、读 TUI footer（模式、cwd、分支、未推送数、上下文占用）、读侧栏 Todo、**验收"输入框是否已清空"**（`│ >  │`，§11.5 必需）。
**分工不变**：读屏用于**交互状态**，落盘 session 文件用于**事实**（§3 建议）。

### 11.3 键名：实测接受 / 被拒

| 类别 | 实测 | 备注 |
|---|---|---|
| 命名键 | `enter`、`return`、`up`、`down`、`left`、`right`、`space`、`backspace`、`delete`、`escape`、`home`、`pageUp`/`pageDown` | `Up`/`Enter`/`backspace` 大小写混写均 OK ⇒ **不敏感** |
| 组合键 | `control-u`、`ctrl-u`、`control-c`、`cmd-k`、`option-up`、`shift-tab` | 形式 `modifier-key` |
| **被拒** | **`C-u`** ⇒ `Error: invalid_params: Unknown key` | **不要用 `C-` / `M-` 缩写** |

> ⚠️ **"返回 OK" 只代表键名合法，不代表产生了预期效果**（对照 §3.1 坑 #1：`send-key space` 返回 OK 但 pi 多选无变化）。

非侵入枚举法：

```bash
strings /Applications/cmux.app/Contents/Resources/bin/cmux \
  | grep -ixE 'up|down|left|right|home|pageup|pagedown|delete|tab|space|enter|return|escape|backspace|control|shift|option|command'
cmux rpc surface.send_key     # → Error: invalid_params: Missing key（只报缺参，无副作用）
```

### 11.4 ⚠️ 按键副作用：`shift-tab` 疑似 kimi 的 Plan mode 开关

批量探键时观测到 kimi footer 由 `Never Ask  K3 thinking: high …` 变为 **`Never Ask plan K3 thinking: high …`**（多出 `plan`），agent 随即转去写计划文件；再发一次 `shift-tab` 后 footer 恢复、回到执行态。

- **因果未逐一隔离**（同批还发过 `control-c`），但 `shift-tab` 是 TUI 里最常见的 plan-mode 开关 ⇒ 按**疑似**记录。
- **规矩**：探键只对"无副作用的状态"做 —— 空输入框，或另开一个一次性 surface；先枚举（§11.3）再实测，**不要盲打**。

### 11.5 ★ `paste-buffer` 的「残留排队行」坑（多行投递必读）

**可靠姿势**：

```bash
cmux set-buffer --name msg '<多行文本>'                    # 存入 cmux 剪贴板缓冲
cmux paste-buffer --name msg --workspace workspace:7       # 括号粘贴进输入框（不提交）
cmux send-key --workspace workspace:7 Enter                # 提交
```

**坑**：粘贴后**输入框会残留消息的最后 1–2 行**，并被渲染成排队项：

```
❯ 4) 每个新用例必须有可判定断言，禁止只跑不判；失败要能给出可读差异。 5) 小步提交…
↑ to edit · ctrl-s to steer immediately
```

**后果**：当前回合结束后，这段残留会**作为第二条 prompt 再投递一次**（等于把一条指令拆成两半、重复发给 agent）。

**清理（实测有效）**：

```bash
cmux send-key --workspace workspace:7 Up                    # = 提示里的 "↑ to edit"：把残留取回输入框
for i in $(seq 1 220); do cmux send-key --workspace workspace:7 backspace; done   # 实测 220 次清空两行
cmux read-screen --workspace workspace:7 --lines 8          # 验收：输入框回到 │ >  │，且不再有 ❯ 行
```

> `Up` 只是把残留**移回输入框**（不会自己消失）；不清就等于留了一颗雷。
> 更稳的替代（待验，见 §9）：改用 `send` 分段 + 逐段 `'\r'`，绕开括号粘贴。

### 11.6 一次读全部窗口/面板状态（排查利器）

```bash
python3 - <<'PY'
import json, pathlib, datetime
p = pathlib.Path.home()/"Library/Application Support/cmux/session-com.cmuxterm.app.json"
d = json.loads(p.read_text())
for i, ws in enumerate(d["windows"][0]["tabManager"]["workspaces"]):
    print(f"[{i}] {ws.get('customTitle') or ws.get('title') or '?'}")
    for pn in ws.get("panels", [])[:3]:
        print("   ", (pn.get("title") or "")[:80])
        for n in pn.get("notifications", [])[-1:]:
            ts = float(n.get("createdAt", 0))
            print("     notif", datetime.datetime.fromtimestamp(ts).strftime("%m-%d %H:%M"),
                  n.get("title"), "|", (n.get("body") or "")[:90])
PY
```

- 一次拿到**所有窗口标题 + 每个面板的最新通知**（agent 完成通知写在这里，如 `Kimi Code task complete: …`）
- 与锁屏无关、不受 `read-screen` 超时影响，是**最快的全局态势读取**
- 同目录另有 `closed-item-history-*.json`、`notification-feed-history-*.json` 可查历史

---

## 12. 附录：kimi（Kimi Code）驱动实测（2026-09-29）

### 12.1 进程与文件布局

| 项 | 实测值 |
|---|---|
| 可执行 | `~/.kimi-code/bin/kimi` |
| 运行方式 | **常驻进程**（实测单个 `kimi` 进程存活 1 天+，cwd = 会话工作目录） |
| 状态根 | `~/.kimi-code/`（`config.toml`、`credentials`、`oauth`、`workspaces.json`、`file-history/`） |
| **会话索引** | `~/.kimi-code/session_index.jsonl`，每行 `{sessionId, sessionDir, workDir}`；**只在新会话创建时追加**（mtime 可能远早于当前活动） |
| 会话目录 | `~/.kimi-code/sessions/wd_<cwd 的 basename 小写>_<12 位 hex>/session_<uuid>/`<br>例：cwd=`~/src/example-plugin` → `wd_example-plugin_a1b2c3d4e5f6/session_<uuid>/` |
| 子 agent | 同会话可有多个 `agents/agent-N/`（实测 15 个）；**只有 `agents/main/` 持续写** |

### 12.2 会话内文件与用途

| 文件 | 内容 | 用途 |
|---|---|---|
| `state.json` | `id/version/cwd/archived/title/titleKind/lastPrompt/createdAt/updatedAt/agents{}` | **判活 + 判"最后收到什么指令"**（`updatedAt`、`lastPrompt`）；`title` 是最初目标 |
| `agents/main/wire.jsonl` | 事件流：`turn.prompt` / `agent.message.appended` / `llm.request` / `usage.record` / `file_history.tracked` / `turn.ended` … | **mtime + 字节数 = 是否在推进**；正文在 `"type":"text"`，思考链在 `"type":"think"` |
| `agents/<id>/tasks/*.json` + `output.log` | 该 agent 的 bash 任务与完整输出 | 回看它跑过什么命令、测试 PASS/FAIL 明细 |
| `agents/main/file-history/` | 每次改动的文件快照 | 复盘它改了什么 |
| `notify/state.json` | 通知状态 | — |

### 12.3 判活 / 定位（不读屏三步）

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

### 12.4 投递消息（实测完整流程）

```bash
WS=workspace:7
MSG='…你的多行指令…'
cmux set-buffer --name msg "$MSG"
cmux paste-buffer --name msg --workspace "$WS"
cmux send-key --workspace "$WS" Enter

cmux read-screen --workspace "$WS" --lines 12    # 应在 2–3 s 内看到消息回显 + ⠹ thinking…
# 然后再收拾残留行（§11.5）并核对落盘
python3 -c "import json;print(json.load(open('<sessionDir>/state.json'))['lastPrompt'][:60])"
```

**成功判据**（三条同时满足才算送达）：`state.json.lastPrompt` == 你发的内容；`wire.jsonl` mtime 更新；屏幕出现 `⠹ thinking…`。

### 12.5 kimi TUI 界面字样（读屏判断用）

| 字样 | 含义 |
|---|---|
| `⠹ thinking…` / `⠸ Thinking…` | 正在跑 |
| `│ >  │`（空） | **空闲，等输入** |
| `❯ <文本>` + `↑ to edit · ctrl-s to steer immediately` | **排队中的消息**（回合结束才消费）—— 也是 §11.5 残留行的形态 |
| footer `Never Ask  K3 thinking: high  <cwd>  <branch> [+85 -2 ↑39]` | 审批模式 / 模型 / 思考档 / cwd / 分支 / 改动量 / **未推送提交数**；含 `plan` = **Plan mode 开** |
| `context: 48% (491k/1M)` | 上下文占用（决定何时触发压缩） |
| `Todo` 面板 `✓` / `●` / `○` | agent 自己的任务清单（完成 / 进行中 / 待办） |
| `… +3 more (3 pending) · ctrl+t to expand` | Todo 折叠项 |
| `✨ <文本>` | 已投递的用户消息回显 |

### 12.6 与 pi 的关键差异

| 项 | pi（§3–§5，锁屏实测） | kimi（本次，未锁屏） |
|---|---|---|
| `send-key enter` | ⚠️ 间歇 15.5 s 超时 | ✅ 返回 OK 且**真的提交** |
| `send-key` 组合键 | `send-key "1"` 无效 | `control-u`/`ctrl-u`/`cmd-k`/`option-up`/`shift-tab` 均接受；`C-u` 不接受 |
| `read-screen` | ⚠️ 间歇超时 | ✅ 连续可用（0.1–11 s） |
| 多行投递 | 单行 `send '文本\r'` | `paste-buffer` + `Enter`（**注意残留行**） |
| 排队语义 | `Steering: <文本>` + `↳ Option+Up to edit all queued messages` | `❯ <文本>` + `↑ to edit · ctrl-s to steer immediately` |
| Plan / Goal 模式 | `▶ Goal … ACTIVE` / `⏸ Goal … STOPPED` | footer `plan` 字样；`Shift+Tab` 切换（**疑似**） |
| session 判定文件 | `~/.pi/agent/sessions/--<cwd转义>--/<ISO>_<uuid>.jsonl`（逐行 JSONL） | `<sessionDir>/state.json` + `agents/main/wire.jsonl`（**事件流**，按 `type` 解析） |
| session 路径规则 | cwd 全路径转义（`-` 连接） | **cwd 的 basename 小写 + hex**（§12.1）；用 `session_index.jsonl` 最稳 |

### 12.7 注意事项（都踩过）

1. **面板标题 ≠ 当前任务**：cmux 面板标题取自会话标题（最初目标，可跨天不变）⇒ 用它判断"它没在动"会误判；要看 `state.json.lastPrompt` 或 `wire.jsonl`。
2. **`state.json.updatedAt` 不等于活跃度**，只看 `wire.jsonl` mtime。
3. **投递后必须查残留行**（§11.5），否则下一回合收到重复指令。
4. **探键不要盲打**（§11.4）。
5. `wire.jsonl` 体量大（实测 14 MB+、1 万+ 行）⇒ **只读尾部 250–500 行**，别整文件解析。
6. 其中的文本是 **JSON 转义**的，取出后需再解一次（`json.loads('"'+raw+'"')`），否则中文乱码。

---

## 13. 附录：Cursor（cursor-agent）驱动实测（2026-09-29）

### 13.1 可执行与版本

```bash
ls -l ~/.local/bin/agent ~/.local/bin/cursor-agent
# agent         -> ~/.local/share/cursor-agent/versions/2026.09.28-64d2043/cursor-agent
ls -lt ~/.local/share/cursor-agent/versions/
# 2026.09.28-64d2043 / 2026.09.26-dd393fe / 2026.09.23-86fc751   ← 多版本并存
```

- **多版本目录并存**：`~/.local/bin/agent` 是符号链接，指向"当前版本"；**运行中的进程锁定它启动时的版本** —— 实测 `ps` 里跑的是
  `…/versions/2026.09.26-dd393fe/index.js --resume=0f4d637f-…`，而 symlink 已指向 `2026.09.28-64d2043`
  ⇒ **升级不会切换已跑的会话**；判版本要看**进程 argv**，不是 symlink。
- `/usr/local/bin/cursor` 是 **IDE（编辑器）CLI**，与 agent CLI **不同物**（agent CLI 内部也有 `agent` 子命令，易混）。

### 13.2 会话标识与存储（**SQLite，不是 JSONL**）

| 项 | 实测值 |
|---|---|
| 会话 id | `--resume=<chatId>`，形如 `0f4d637f-8b9c-43a7-872b-f6c52d8ccb09`（UUID） |
| 根目录 | `~/.cursor/chats/`；同级还有 `agent-cli-state.json`、`cli-config.json`、`hooks.json`、`agents/`、`acp-sessions/` |
| 单会话库 | `~/.cursor/chats/<32 位 hex 工程哈希>/<chatId>/store.db`（含 `-wal` / `-shm`） |
| schema | `blobs(id TEXT PRIMARY KEY, data BLOB)`、`meta(key TEXT PRIMARY KEY, value TEXT)` |
| 规模（实测） | `blobs` **13184 行**、`store.db` ≈ **219 MB**；`meta` 仅 **1 行**（JSON：`{"agentId":…,"latestRootBlobId":…}`） |
| blob 内容 | **两类混杂**：① 可读 JSON（`{"role":"assistant"/"tool","content":[…]}`）② **二进制哈希节点**（protobuf 风格，如 `0a20<32B 哈希>`）⇒ **不能逐行当文本读** |
| 日志 | `$TMPDIR/cursor-agent-logs-<uid>/session-<ISO>-<pid>-<n>.log`（**在 TMPDIR** ⇒ 重启/清理后消失，不能当长期证据） |

**判活**（只读，不干扰运行中的会话）：

```bash
DB=~/.cursor/chats/<32hex>/<chatId>/store.db
stat -f 'mtime=%Sm size=%z' -t '%H:%M:%S' "$DB"       # 实测：23:20:35 / 219480064 B
```

**取最近对话**（只挑 JSON 类 blob）：

```bash
# 注意：data 是 BLOB，必须用十六进制字面量 X'7B'（= '{'）比较；
#       写成 substr(data,1,1)='{' 会因「BLOB 与 TEXT 恒不相等」返回 0 行（实测踩过）
sqlite3 "file:$DB?mode=ro" \
  "select id, substr(cast(data as text),1,200) from blobs where substr(data,1,1)=X'7B' order by rowid desc limit 20;"
```

实测：`blobs` 共 13184 行，其中 **JSON 类 3468 行**（其余为二进制哈希节点/附块）；取尾部可读到
`{"role":"assistant","content":[{"type":"reasoning",…}]}`、`{"role":"tool","content":[{"type":"tool-result",…}]}` 等真实条目。

> 二进制 blob 是**内容寻址的树节点**（`meta.latestRootBlobId` 指向根，实测 `5094061b0…`）；要完整重建对话需按树解码，本次**未做**（见 §9 待验）。

### 13.3 ★ 非交互通道（pi / kimi 都没有的能力）

```bash
cursor-agent --help          # Usage: agent [options] [command] [prompt...]
cursor-agent -p "解释一下这个报错" --output-format text|json|stream-json
cursor-agent --resume <chatId> -p "继续"      # 续指定会话
cursor-agent --continue -p "继续"             # 续最近会话
cursor-agent create-chat                      # 新建会话并打印 chatId
cursor-agent ls | resume | status|whoami | models | update | persist
```

关键选项（`--help` 原文）：

- `-p/--print`：非交互模式；说明里写明 **"Has access to all tools, including write and shell"**
  ⇒ **无人值守调用务必配** `--mode plan`（只读规划）/ `--mode ask`（仅问答）/ `--sandbox enabled`；要显式放开才用 `-f/--force`（别名 `--yolo`）
- `--mode plan|ask`、`--model <name>`（支持 `'claude-opus-4-8[context=1m,effort=high]'` 形态）、`--workspace <path|name>`、`--add-dir`、`-w/--worktree`（隔离 git worktree）、`--auto-review`（服务端分类器自动放行安全工具调用）
- `persist` 子命令：**断连存活**的会话（挂了终端也不停，适合长任务）
- `--output-format stream-json --stream-partial-output`：**结构化流式**消费 ⇒ 对 bridge 而言比 TUI 注入更稳的长期路线

> ⚠️ `[未验证]`：本次**未实际执行** `-p` 端到端（避免消耗账号额度与产生副作用）；以上来自 `--help` 原文与本地事实。落地前建议先 `--mode plan` 跑一次最小验证。

### 13.4 cmux 里的 Cursor 面板

- **它就是一个普通 terminal panel**（不是 cmux 原生 agent 面板）：实测 `workspace:1 surface:1`、`tty=<pty 名>`、标题为会话/cwd 相关文案
  （标题随 cwd/任务而变，**不代表当前动作**）
- ⇒ **投递消息同 §11.5**：`set-buffer` → `paste-buffer` → `send-key Enter`；**投递后照样要清残留行**
- "在等你"的状态靠**通知**体现（`Cursor is waiting for you`），机制见 §14

### 13.5 与 pi / kimi 的对比

| 项 | pi | kimi | **Cursor（cursor-agent）** |
|---|---|---|---|
| 非交互通道 | ✅ `--mode rpc` | `[未验证]`（存在 `~/.kimi-code/server` + `server.token`） | ✅ **`-p/--print` + `--output-format json/stream-json`** |
| 会话存储 | `~/.pi/agent/sessions/--<cwd转义>--/*.jsonl`（逐行 JSONL） | `<sessionDir>/state.json` + `agents/main/wire.jsonl`（事件流） | `~/.cursor/chats/<hash>/<chatId>/store.db`（**SQLite blob**） |
| 判活 | JSONL 行数 / mtime | `wire.jsonl` mtime / size | `store.db` mtime / size |
| 读对话 | 直接读 JSONL | 解析 `wire.jsonl` 事件 | **只能取 `substr(data,1,1)='{'` 的 blob** |
| 会话 id | session 文件名 | `state.json.id` | **`chatId`（`--resume=`）** |
| 版本管理 | — | — | **多版本并存，运行中的进程锁旧版本** |
| 可执行 | `~/.bun/bin/pi` | `~/.kimi-code/bin/kimi` | `~/.local/bin/agent`（symlink）/ `cursor-agent` |
| 提交署名 | — | — | `Co-authored-by: Cursor <cursoragent@cursor.com>`（据此区分"谁写的"） |

---

## 14. agent 通知机制：`~/.orca/agent-hooks` ⇄ cmux 通知

**问题**：cmux 面板为什么会冒出 `Cursor is waiting for you`、`Kimi Code task complete: …`？
**答案**：cmux 的 agent 集成层（代号 **orca**）往每个 agent 里装了 **hook 脚本**；agent 在生命周期事件上调用它，脚本把 payload POST 回本机端口，cmux 再生成**面板通知**。

### 14.1 组件與落点

| 组件 | 实测位置 |
|---|---|
| hook 脚本 | `~/.orca/agent-hooks/<agent>-hook.sh` —— 实测 **11 个**：`antigravity` / `claude` / `codex` / `command-code` / `copilot` / **`cursor`** / `devin` / `droid` / `gemini` / `grok` / **`kimi`** / `openclaude` |
| 安装落点（Cursor） | `~/.cursor/hooks.json`（`afterAgentResponse`、`beforeSubmitPrompt`、`beforeShellExecution`、`beforeMCPExecution` …） |
| 安装落点（kimi） | `~/.kimi-code/config.toml` 的 `[[hooks]]` |
| 投递端点 | `http://127.0.0.1:${ORCA_AGENT_HOOK_PORT}/hook/<agent>`，带 `X-Orca-Agent-Hook-Token: ${ORCA_AGENT_HOOK_TOKEN}` |
| 环境注入 | `ORCA_AGENT_HOOK_PORT` / `ORCA_AGENT_HOOK_TOKEN` / `ORCA_PANE_KEY` / `ORCA_TAB_ID` / `ORCA_AGENT_LAUNCH_TOKEN` / `ORCA_WORKTREE_ID` / `ORCA_AGENT_HOOK_ENV` / `ORCA_AGENT_HOOK_VERSION`（由 cmux pane 注入；kimi 的脚本还会 source `$ORCA_AGENT_HOOK_ENDPOINT`） |
| 安装命令 | `cmux hooks setup`（会先列出将写入哪些 agent 配置） |
| 通知落点 | cmux session JSON 的 `panels[].notifications[]`（`title` / `body` / `createdAt` / `scrollPosition`）⇒ **§11.6 的脚本可直接读到** |

### 14.2 hook 脚本长什么样（`cursor-hook.sh` 截取）

```sh
#!/bin/sh
payload=$(cat)
[ -z "$payload" ] && exit 0
[ -n "$ORCA_AGENT_HOOK_ENDPOINT" ] && [ -r "$ORCA_AGENT_HOOK_ENDPOINT" ] && . "$ORCA_AGENT_HOOK_ENDPOINT" 2>/dev/null || :
[ -z "$ORCA_AGENT_HOOK_PORT" ] || [ -z "$ORCA_AGENT_HOOK_TOKEN" ] || [ -z "$ORCA_PANE_KEY" ] && exit 0
printf '%s' "$payload" | curl -sS -X POST "http://127.0.0.1:${ORCA_AGENT_HOOK_PORT}/hook/cursor" \
  --connect-timeout 0.5 --max-time 1.5 \
  -H "X-Orca-Agent-Hook-Token: ${ORCA_AGENT_HOOK_TOKEN}" \
  --data-urlencode "paneKey=${ORCA_PANE_KEY}" --data-urlencode "payload@-" …
```

两个关键推论：

1. **只有「从 cmux 面板内启动」的 agent 才有 `ORCA_*` 环境变量** —— 与 §1.1 的 `socketControlMode` 是**两条独立链路**。
   ⇒ **外部进程（如 bridge、launchd）启动的 agent 不会产生 cmux 通知**；反过来，通知存在即说明该 agent 跑在 cmux 面板里。
2. hook 有 0.5–1.5 s 超时且末尾 `|| true` ⇒ **不会阻塞 agent**，hook 失败也静默。

### 14.3 排查表

| 症状 | 检查 |
|---|---|
| 面板从不出通知 | ① hook 文件存在且可执行（`ls -l ~/.orca/agent-hooks/<agent>-hook.sh`）；② agent 配置里有 hook 条目（`~/.cursor/hooks.json`、`~/.kimi-code/config.toml`）；③ **agent 是否从 cmux 内启动** |
| 通知重复 / 未读堆积 | `cmux list-notifications`、`cmux mark-notification-read --all`、`cmux clear-notifications`；历史见 `~/Library/Application Support/cmux/notification-feed-history-com.cmuxterm.app.json` |
| 想主动推状态 | `cmux notify [--title …] [--body …] [--reply]`、`cmux set-status <key> <value>`、`cmux set-progress <0..1>` |
| 长时间没更新的面板 | 看 `panels[].notifications[].createdAt`（§11.6），比读屏更快判断「最后一次动是什么时候」 |
