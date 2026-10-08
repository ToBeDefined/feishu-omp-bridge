---
name: cmux-agent
description: Drive pi/omp/kimi/Cursor agent TUIs running inside cmux terminals remotely (from bridge, Feishu, or any external process). Use when asked to send messages to, read screens of, steer, interrupt, or verify cmux-hosted agent sessions; locate workspaces/surfaces; inject keys into TUI wizards; or debug why a cmux-hosted agent is not responding.
---

# cmux × agent TUI 远程驱动

在 cmux 终端里跑的 agent（pi/omp、kimi、Cursor）从外部进程（feishu-omp-bridge、脚本）远程操控。

## 三条铁律

1. **只用 `send`（文本通道），不用 `send-key`** —— 全体键名当前报 `Unknown key`（见 `references/cli-basics.md` §3.4）
2. **Enter 用 `'\r'`**（`cmux send --surface X '文本\r'` 或分两步）；`'\n'` 可能不提交
3. **验证读落盘状态（session 文件 / store.db / state.json），不读屏**；`read-screen` 可能超时，仅作辅助

## 核心循环：定位 → 观察 → 投递 → 验证

### 1. 定位目标 surface

```bash
cmux list-workspaces                      # * = 当前选中；编号会跳号，必须先拿 ref
cmux list-panels --workspace workspace:7  # 取 surface:<n>
cmux tree --all --json                    # 或一次性拿全树
```

面板标题是**会话初始目标，不随当前动作变化**——别用它判断"它现在在干什么"。

### 2. 投递（send 文本通道）

```bash
cmux send --surface surface:1 '消息文本\r'   # idle：一步提交
cmux send --surface surface:1 '长文本'       # busy：进 follow-up 队列（屏幕下方 ○ 框）
cmux send --surface surface:1 '\r'           # 队列消息 steer 进当前回合（立即注入）
cmux send --surface surface:1 "$(printf '\x03')"   # 停止回合（Esc/control-c 不可靠，用 \x03 字节）
```

- 长文本尾部 `\r` 会被**括号粘贴吞掉**（kimi/cursor）：分两步——先发文本，再单独发 `'\r'`。提交与否看输入框：文本还在 `-> ` 处 = 未提交
- **按键注入**（向导/选择器）：方向键 `\x1b[A/B/C/D`、Shift+Tab `\x1b[Z`、Esc `\x1b`、Ctrl+C `\x03`，均经 `printf` + `send` 实证可用；纯字母键（j/k、h/l、数字 1-9、空格）最稳。详见 cli-basics §3.4
- 提示变 **`enter interrupt and send`** 时再按 Enter 会**中断当前工具调用**——先确认这是不是你想要的

### 3. 验证（按 agent 选数据源）

| agent | 判活 / 验证 | 详见 |
|---|---|---|
| pi / omp | `~/.pi/agent/sessions/--<cwd 转义>--/<ISO>_<uuid>.jsonl` 的行数/mtime | `references/pi.md` §2.2、§4 |
| kimi | `<sessionDir>/state.json` + `agents/main/wire.jsonl` mtime+size（只读尾部 250-500 行） | `references/kimi.md` §1 |
| cursor | `~/.cursor/chats/<32hex>/<chatId>/store.db`（SQLite）`stat` mtime/size；JSON blob 用 `substr(data,1,1)=X'7B'` 过滤 | `references/cursor.md` §1.2 |

### 4. 读屏（辅助手段）

```bash
cmux read-screen --surface surface:1 --lines 30 | tail -27 | cut -c1-145
```

输出可能含二进制控制符：管道加 `LC_ALL=C grep -a`；macOS `sed` 遇非法 UTF-8 会中断，用 `awk 'NR>=a && NR<=b'` 取行段。

## 高频场景速查

| 场景 | 操作 |
|---|---|
| 确认收到并执行 | 验证 session 文件追加 / wire.jsonl mtime 前进 |
| busy 时补充指令 | `send '文本'` 进 ○ 队列（回合结束消费）；要立即生效再发 `'\r'` steer |
| 撤回已排队消息 | cmux CLI **无远程撤回命令**；`\x03` 停回合不会清队列。需用户在终端 `^` 选中 + `esc` |
| 交互式向导（多选/单选） | `read-screen` 读全部选项 → 实测按键 → 空格勾选/数字选择 → `'\r'` 进提交页 →（`\x1b[Z` 测切换）→ `'\r'` 提交 |
| 一次读全部窗口状态 | `~/Library/Application Support/cmux/session-com.cmuxterm.app.json`（windows→workspaces→panels + notifications，比逐个读屏快） |
| 判断"它在等你" | 上面 JSON 里面板 `notifications[]`（`pi is waiting for you` / `Cursor is waiting for you`） |

## 前置条件

cmux 需开启 `Settings → Automation → Socket Control Mode → Automation`；从外部进程 `cmux identify` 能返回即通。完整检查清单与运维备忘见 `references/cli-basics.md` §1–2（前置）、`references/pi.md` §6（运维）。

## 深入索引

| 文件 | 内容 |
|---|---|
| `references/cli-basics.md` | 权限前置(§1)、命令面(§2)、surface 定位(§3.1)、read-screen(§3.2)、键名与 send-key 回归(§3.3/3.4)、按键副作用(§3.5)、paste-buffer 残留坑(§3.6)、一次读全状态(§3.7) |
| `references/pi.md` | 锁屏能力矩阵(§1)、pi/omp 区分(§2)、投递语义(§3)、session 定位与推进判定(§2.2/4)、回答交互提问速查(§5) |
| `references/kimi.md` | state.json/wire.jsonl 驱动(§1.3)、投递与残留行清理(§1.4)、多行投递 |
| `references/cursor.md` | 版本锁定 argv 非 symlink(§1.1)、store.db SQLite 读取(§1.2)、`-p` 非交互通道与权限警告(§1.3)、TUI 注入差异(§1.4–1.6) |
| `references/notifications.md` | `~/.orca/agent-hooks` ⇄ cmux 通知机制(§1) |

> 本目录（仓库 `cmux-agent/`）为源头；运行时读取的是符号链接 `~/.claude/skills` / `~/.pi/agent/skills` → `~/.agents/skills`，改动后需 `cp -R` 同步到 `~/.agents/skills/cmux-agent/`。
