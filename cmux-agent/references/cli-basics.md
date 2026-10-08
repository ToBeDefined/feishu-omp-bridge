# cmux CLI 通用：权限前置、常用命令、定位/键名/投递细节（§1–3）
> 章节号为本文件自编号（1 起）；跨文件引用写作「文件名 §x.y」。SKILL.md 主入口见 ../SKILL.md。

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
[ ] 知悉：send-key 不可靠，一律用 send（见 pi.md §1）
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

## 3. cmux CLI 通用补充

### 3.1 定位：workspace / pane / surface 的取法

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
- `list-panels` 给出的标题是**会话/面板标题**，**不随当前动作变化** ⇒ 别用它判断"它现在在干什么"（见 kimi.md §1.7-1）。

### 3.2 `read-screen` 在未锁屏下可用

```bash
cmux read-screen --workspace workspace:7 --lines 40     # 实测 0.1–11 s 返回，连续多次稳定
```

用途：判断目标状态（thinking / 空闲 / 有排队消息）、读 TUI footer（模式、cwd、分支、未推送数、上下文占用）、读侧栏 Todo、**验收"输入框是否已清空"**（`│ >  │`，§3.6 必需）。
**分工不变**：读屏用于**交互状态**，落盘 session 文件用于**事实**（pi.md §1 建议）。

### 3.3 键名：实测接受 / 被拒

| 类别 | 实测 | 备注 |
|---|---|---|
| 命名键 | `enter`、`return`、`up`、`down`、`left`、`right`、`space`、`backspace`、`delete`、`escape`、`home`、`pageUp`/`pageDown` | `Up`/`Enter`/`backspace` 大小写混写均 OK ⇒ **不敏感** |
| 组合键 | `control-u`、`ctrl-u`、`control-c`、`cmd-k`、`option-up`、`shift-tab` | 形式 `modifier-key` |
| **被拒** | **`C-u`** ⇒ `Error: invalid_params: Unknown key` | **不要用 `C-` / `M-` 缩写** |

> ⚠️ **"返回 OK" 只代表键名合法，不代表产生了预期效果**（对照 pi.md §1.1 坑 #1：`send-key space` 返回 OK 但 pi 多选无变化）。

### 3.4 ★ `send-key` 整体失效，`send` 转义序列是可靠键通道（未锁屏）

**`send-key` 全体键名报 `Error: invalid_params: Unknown key`**（含 §3.3 表中全部合法键名）。在此修复前，**按键一律走 `send` 文本通道**：

```bash
cmux send --surface X "$(printf '\x1b[A')"   # ↑；B/C/D = ↓→←
cmux send --surface X "$(printf '\x1b[Z')"   # Shift+Tab（提交页 提交↔取消 切换实测）
cmux send --surface X "$(printf '\x1b')"     # Esc（取消/返回；\x03 = Ctrl+C 停回合）
cmux send --surface X 'j'                    # 纯字母键最稳：j/k、h/l、数字 1-9、空格、'\r'
```

以上键位均在 ask 向导实测生效；`j/k`、`h/l` 备用键与方向键等价。

⚠️ 「键没反应」不一定是传输问题——可能是**目标 TUI 自身不解析该编码**（历史上有过此误判）。判定前先用字母键交叉验证。

非侵入枚举法：

```bash
strings /Applications/cmux.app/Contents/Resources/bin/cmux \
  | grep -ixE 'up|down|left|right|home|pageup|pagedown|delete|tab|space|enter|return|escape|backspace|control|shift|option|command'
cmux rpc surface.send_key     # → Error: invalid_params: Missing key（只报缺参，无副作用）
```

### 3.5 ⚠️ 按键副作用：`shift-tab` 疑似 kimi 的 Plan mode 开关

批量探键时观测到 kimi footer 由 `Never Ask  K3 thinking: high …` 变为 **`Never Ask plan K3 thinking: high …`**（多出 `plan`），agent 随即转去写计划文件；再发一次 `shift-tab` 后 footer 恢复、回到执行态。

- **因果未逐一隔离**（同批还发过 `control-c`），但 `shift-tab` 是 TUI 里最常见的 plan-mode 开关 ⇒ 按**疑似**记录。
- **规矩**：探键只对"无副作用的状态"做 —— 空输入框，或另开一个一次性 surface；先枚举（§3.3）再实测，**不要盲打**。

### 3.6 ★ `paste-buffer` 的「残留排队行」坑（多行投递必读）

**可靠姿势**：

```bash
cmux set-buffer --name msg '<多行文本>'                    # 存入 cmux 剪贴板缓冲
cmux paste-buffer --name msg --workspace workspace:7       # 括号粘贴进输入框（不提交）
cmux send --surface <ref> '\r'                             # 提交（send-key 已失效，见 §3.4）
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
> 更稳的替代（待验，见 pi.md §7）：改用 `send` 分段 + 逐段 `'\r'`，绕开括号粘贴。

### 3.7 一次读全部窗口/面板状态（排查利器）

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

