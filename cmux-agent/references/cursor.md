# Cursor（cursor-agent）驱动实测（§1）
> 章节号为本文件自编号（1 起）；跨文件引用写作「文件名 §x.y」。SKILL.md 主入口见 ../SKILL.md。

## 1. 附录：Cursor（cursor-agent）驱动实测

### 1.1 可执行与版本

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

### 1.2 会话标识与存储（**SQLite，不是 JSONL**）

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
#       写成 substr(data,1,1)='{' 会因「BLOB 与 TEXT 恒不相等」返回 0 行
sqlite3 "file:$DB?mode=ro" \
  "select id, substr(cast(data as text),1,200) from blobs where substr(data,1,1)=X'7B' order by rowid desc limit 20;"
```

**内部 TODO 列表**：agent 的 TodoWrite 结果也落在本库 `blobs`（`role:"tool"` 的 tool-result blob）。取最新一份：

```bash
sqlite3 "file:$DB?mode=ro" "
  select substr(cast(data as text), instr(cast(data as text),'todos'), 4000)
  from blobs where cast(data as text) like '%\"todos\"%'
  order by rowid desc limit 1;"
```

解析出的数组含 `id / content / status`，status 为 `TODO_STATUS_COMPLETED / _IN_PROGRESS / _PENDING`。**屏幕上 To-do 面板被收起时，这是唯一可靠的状态来源**（转录 jsonl 在 /summarize 后不再记录工具调用）。

实测：`blobs` 共 13184 行，其中 **JSON 类 3468 行**（其余为二进制哈希节点/附块）；取尾部可读到
`{"role":"assistant","content":[{"type":"reasoning",…}]}`、`{"role":"tool","content":[{"type":"tool-result",…}]}` 等真实条目。

> 二进制 blob 是**内容寻址的树节点**（`meta.latestRootBlobId` 指向根，实测 `5094061b0…`）；要完整重建对话需按树解码，本次**未做**（见 pi.md §7 待验）。

### 1.3 ★ 非交互通道（pi / kimi 都没有的能力）

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

### 1.4 cmux 里的 Cursor 面板

- **它就是一个普通 terminal panel**（不是 cmux 原生 agent 面板）：实测 `workspace:1 surface:1`、`tty=<pty 名>`、标题为会话/cwd 相关文案
  （标题随 cwd/任务而变，**不代表当前动作**）
- ⇒ **投递消息同 cli-basics.md §3.6**：`set-buffer` → `paste-buffer` → `send-key Enter`；**投递后照样要清残留行**
- "在等你"的状态靠**通知**体现（`Cursor is waiting for you`），机制见 notifications.md §1

### 1.5 TUI 内切换模型 / Context / Effort

适用对象：**cmux 里跑着的 cursor-agent TUI**（`cursor-agent -p` 非交互通道没有这个问题，直接用 `--model 'claude-opus-4-8[context=1m,effort=high]'`）。

**打开模型选择器**

```bash
cmux send --surface surface:1 '/model\r'
```

选择器列出 42 个模型（页脚 `1-10 of 42`），每行右侧标注 context/effort 组合（如 `1M Medium`），选中行提示 `(Tab to modify)`。

**★ 坑：`send` 文本进不了选择器的 Filter 框**

- 在选择器打开时 `cmux send --surface X 'gpt-5.6'` → 文本**没有落进 Filter 输入框**（读屏确认 `Filter:` 后为空）；
- 此时 `send '\r'` 只会**空手关闭选择器，模型不变**；
- ⇒ 选择器内**不能走文本通道，必须用 `send-key` 方向键**（与 SKILL.md 三条铁律在 cursor 场景的例外：选择器里 `send` 无用）。

**正确步骤（方向键 + `\r`）**

```bash
cmux send-key --surface surface:1 down|up     # 移动高亮（键名小写即可，cli-basics.md §3.3）
cmux read-screen --surface surface:1          # grep '→' 确认高亮位置（必做，别盲数）
cmux send --surface surface:1 '\r'            # Enter 选中生效
cmux read-screen --surface surface:1          # 页脚应变为 <模型> <context> <effort> · MAX
```

实测：`Claude Opus 5.5 1M Medium` →（down×3 + Enter）→ `GPT-5.6 Sol 1M Max` →（`/model` + up×3 + Enter）→ 还原成功。

**调整 Context / Effort（Tab 进参数面板）**

在选择器内对高亮模型按 **Tab**（即行尾提示 `Tab to modify` / `Tab to edit`），进入 `<模型名> — Edit Parameters` 面板：

```
Context: ○ 300K / ● 1M
Effort:  ○ Low / ○ Medium / ○ High / ○ Extra High / ○ Max
另有 ◯ Fast（疑似独立开关，未实测）
↑/↓ to navigate • Enter to select • Esc to go back
```

```bash
cmux send --surface surface:1 '/model\r'; sleep 2
cmux send-key --surface surface:1 tab         # 进 Edit Parameters
cmux send-key --surface surface:1 down        # 移动单选（光标每次进入默认停在 Context 的 300K 行）
cmux send --surface surface:1 '\r'            # Enter 确认
cmux send-key --surface surface:1 escape      # Esc ×2 退回主界面
cmux read-screen --surface surface:1          # 页脚验证，如 1M High
```

实测：Effort Medium → `down`×3 + Enter → 页脚变 `Claude Opus 5.5 1M High · MAX`；同法还原 `Medium` 成功。

**注意**：

1. 页脚有两行（输出区底部一行 + 输入框下一行），还原验证时两行都应一致。
2. **Tab 进面板后光标总是重置到 Context 300K 行**，导航前先读屏定位，不要复用上次的步数。
3. `/model` 与参数修改都是**立即生效**的会话级设置，改完直接留在页脚；误改按同路径改回即可。

### 1.5.1 向空闲面板投递消息与残留行清理

**投递**（idle 时一步到位）：

```bash
cmux send --surface <ref> '继续\r'      # 文本 + '\r' 一次送达，立即被消费，状态转 Working
```

**★ 残留行：`'\r'` 提交后输入框会残留消息文本**（表现为输入框行显示 `→ <消息>`，而正常空闲是 `→ Add a follow-up` 占位符）。
不清掉的话，**回合结束会被再次提交**，变成重复指令（同 cli-basics.md §3.6 kimi 的坑）。

**清理步骤（cursor 专属，与 kimi 不同）**：

```bash
cmux send-key --surface <ref> end        # ① 光标先到行尾 —— 必做！
cmux send-key --surface <ref> backspace  # ② 按 消息长度×2 次退格（CJK 宽字符多按几次）
cmux read-screen --surface <ref>         # ③ 验收：输入框回到「→ Add a follow-up」占位符
```

两个实测踩坑：

1. **不要按 `Up`**：cursor 输入框里 `Up` 是**历史召回**（会把已提交的消息取回输入框），与 kimi 的「↑ to edit」语义不同；误按后照样用 `end` + backspace 清。
2. **backspace 无效先查光标位置**：光标在行首时 backspace 是 no-op（实测连按 6 次无变化，用 `end` 后立刻生效）。可用「打一个探测字符（如 `x`）看它落在哪」来确认输入框可编辑性与光标位置（探完记得删）。

**★ 长文本投递：尾部 `'\r'` 会被吞掉**：

```bash
# ❌ 长文本一次发：走括号粘贴路径，尾部的 \r 被吃掉 → 文本留在输入框但不提交
cmux send --surface <ref> '很长的一段话……\r'

# ✅ 分两步：先送文本，再单独发提交键
cmux send --surface <ref> '很长的一段话……'
cmux send --surface <ref> '\r'
```

判断是否已提交：读屏看输入框——**文本还在输入框（`→ <文本>`）= 未提交**，补发 `'\r'` 即可；已提交则输入框回占位符且状态转 `Working`。

**busy 时补充指令：排队 + Enter steer 立即注入**：

- 目标 busy 时 `send` 的消息会进入 follow-up 排队区（屏幕下方 `○ <文本>` 框，提示 `enter steer · ↑ select/edit · esc cancel`），**回合结束才消费**；
- 要**立即注入当前回合**：对 surface 发 `'\r'` 触发 steer。多条排队时逐条出队；若提示变为 **`enter interrupt and send`**，再按一次 Enter 会**中断当前工具调用并打包发送全部排队消息**；
- steer 后 agent 会先回应补充内容再继续原任务，工作不中断（实测整理任务中被正确消化）。

**★ 停止回合：`Esc` 和 `send-key control-c` 都不可靠，用 `\x03` 字节**：

```bash
cmux send-key --surface <ref> escape       # ❌ 连按两次也无法停止运行中的回合
cmux send-key --surface <ref> control-c    # ❌ 返回 OK 但无效果
cmux send --surface <ref> "$(printf '\x03')"   # ✅ 真正停止（footer 的 ctrl+c to stop 消失）
```

注意：`\x03` 停止后 agent 可能立刻弹出 AskQuestion 提问框；若选项勾选失效（space 无效果、Enter 空提交被记为 "Questions skipped by user"），**用普通 follow-up 消息把答案喂回去**即可，agent 会正常消化。

**★ `/summarize` 的副作用**：压缩会丢掉近期的操作记忆，导致 agent 把**自己的改动**当成"别的会话/入侵"（实测把 16:59 自己编辑的文件、自己拉起的后台构建认成外来操作，还弹出工作区并发确认）。处置：向它确认"系统里只有一个 agent 进程（`ps` 查 `agent --resume=<chatId>` 的父子链即可实证）"，指明那些改动是它 summarize 前的工作。判断当前活着的会话数用进程树，不要信 agent 的猜测。

**验收标准**：输入框回到 `→ Add a follow-up`；agent 侧不受影响（footer 的任务/token 计数继续走，`ctrl+c to stop` 提示仍在 = 仍在运行）。

### 1.6 与 pi / kimi 的对比

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

