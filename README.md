# feishu-omp-bridge

把飞书 / Lark 消息接入本地 Oh My Pi CLI 的桥接服务。它会把私聊、群聊、话题群、云文档评论中的消息转给 `omp --mode rpc`，再把 OMP 的文本、thinking、工具调用、工具增量、原生 UI 交互和结果流式回写到飞书。

## 项目定位

`feishu-omp-bridge` 不是重新实现一个飞书机器人框架，而是把已有 Feishu/Lark 桥接层和 OMP 的 RPC Agent 能力接起来：

```text
Feishu / Lark
  ↓ WebSocket / OpenAPI
@larksuiteoapi/node-sdk LarkChannel
  ↓ normalized messages / card actions
src/bot/channel.ts
  ↓ AgentAdapter
src/agent/omp/OmpAdapter
  ↓ JSONL stdio RPC
omp --mode rpc --session-dir ~/.feishu-omp-bridge/omp-sessions
```

它适合以下场景：

- 在飞书里直接让本地 OMP 读写项目、运行命令、分析日志、修代码。
- 让团队用飞书群 / 话题群共享一个可恢复的 OMP 会话。
- 让 OMP 原生 `confirm` / `select` / `input` / `editor` UI 在飞书交互卡片中完成。
- 把飞书上下文以 OMP host tools / host URI 的形式暴露给 Agent，而不是让 Agent 绕到 shell 里调用 `lark-cli`。

## 核心能力

### 消息与会话

- 支持飞书 / Lark 私聊、普通群聊 `@bot`、话题群 topic、云文档评论 `@bot`。
- 每个 chat / topic 独立保存**工作会话**（见下节），下一轮用 `omp --mode rpc --resume <session_id>` 续聊最新的一段。
- 话题群按 `chatId:threadId` 隔离工作会话、cwd、pending queue 和 active run。
- 支持图片输入：飞书图片会下载到本地缓存，再转成 OMP RPC image payload。
- 支持文件下载缓存，供 OMP 后续按本地路径读取。
- 支持消息 debounce：短时间连续消息会合并成一个 batch prompt。

### 工作会话

一次工作由 `/work [名字]` 开启，这是**唯一**的会话边界。OMP 会话只是它的**段**：`/new`（只重置上下文）、`/cd`、`/ws use`、`/resume`、OMP 漂移、`/release` 重启都只在同一工作会话里追加 / 切换段，不新开工作。工作会话 id = 它**第一段**的 OMP 会话 id，段再多也不变。

- 标题属于工作会话：`/rename` 命名它；没名字时 `/history`、`/search`、`/resume` 回退显示该工作会话最后一条用户消息。
- `/history` 一行 = 一个工作会话（标注段数 / 轮数）；「继续对话」恢复最新段，`/history seg <id>` 展开各段、可单独恢复。
- `/work merge <id> [id]`、`/work split <id> <段序号>` 手工修正历史分段。
- 历史用 `bridge migrate work-sessions`（默认 dry-run，`--apply` 落盘）按日志边界回填。

### OMP RPC 流式输出

- 流式展示 OMP 文本输出。
- 展示 thinking / reasoning 片段。
- 展示工具调用开始、增量更新和最终结果。
- 展示 token usage（当 OMP RPC 返回 usage 时）。
- 支持中断：`/stop` 会向 OMP 发送 `abort`，随后按 grace period 终止进程。

### OMP 原生 UI → 飞书交互卡片

OMP RPC 的 extension UI request 会被映射为飞书卡片，并把用户响应写回同一个 live RPC run：

| OMP UI method | 飞书表现 | 写回 OMP |
| --- | --- | --- |
| `confirm` | 确认 / 否 / 取消按钮 | `extension_ui_response` |
| `select` | 下拉选择 + 提交 / 取消 | `extension_ui_response` |
| `input` | 单行输入 + 提交 / 取消 | `extension_ui_response` |
| `editor` | 多行输入 + 提交 / 取消 | `extension_ui_response` |

非阻塞 UI 事件会渲染进运行卡片或文本输出：

- `notify`
- `setStatus`
- `setWidget`
- `setTitle`
- `set_editor_text`
- `open_url`

当 OMP 正在等待 UI 响应时，idle watchdog 会暂停；用户提交或取消后再恢复探活，避免误杀等待人工输入的 run。

### Feishu-native OMP host surface

每个 OMP run 启动时都会注册 Feishu host tools：

| Tool | 用途 |
| --- | --- |
| `feishu_current_context` | 返回当前 scope、chat、topic、触发消息、cwd。 |
| `feishu_send_message` | 向当前 chat 或显式 `chatId` 发送 Markdown。 |
| `feishu_reply_message` | 回复触发消息或显式 `messageId`。 |
| `feishu_get_message` | 按 `messageId` 拉取并规范化飞书消息。 |
| `feishu_send_file` | 上传本地文件 / 图片并发送到当前 chat 或显式 `chatId`。 |
| `feishu_send_card` | 用标题 + markdown 正文 + 按钮列表发交互卡片，点击经 `__codex_cb` 回填为 `[card-click]`。 |
| `feishu_recall_message` | 撤回 bot 自己发出的消息。 |
| `feishu_view_image` | 把本地图片注入当前 run，让模型直接看图。 |

同时注册只读 `feishu://` host URI scheme：

- `feishu://current/context`
- `feishu://message/<message_id>`

这使 OMP 可以通过结构化 host callback 使用飞书**消息面**资源（消息收发、历史、卡片、文件），而不是让模型在 shell 里拼 `lark-cli` 命令。桥接层负责权限、当前上下文、消息解析和结果格式化。

**访问边界**（防止 prompt injection 把 host tools 变成外泄通道）：

- 显式 `chatId` 只在 `preferences.access.allowedChats` 允许时生效（未配置 =
  不限制）；越界返回明确错误，不会静默发送。
- `feishu_send_file` / `feishu_view_image` 的 `path` 只允许 session cwd、
  媒体缓存目录、临时目录（含 symlink 解析后的真实路径），其余一律拒绝 ——
  `~/.feishu-omp-bridge/`（config.json / keystore）与任意 `$HOME` 路径都
  发不出去。需要发送别处的文件时，让 agent 先复制到 cwd。

> **能力边界**：bridge 只封装 IM 消息面。飞书生态面（文档 / 表格 / 多维表格 /
> 日历 / 会议 / 审批等）**不重复实现** —— agent 需要时直接调用 `lark-cli`
> （或对应的 lark-* skill），bridge 不做第二份封装。

### Mid-run follow-up / steer

当某个 chat/topic 已经有 OMP run 正在执行时，同一 scope 的普通新消息**不会丢失**：它们进入 pending 队列，等当前 run 结束后合并进下一轮（600ms 静默后刷新）。只有以 `!` 开头的消息会直接写入当前 RPC run 进行 steer：

- 普通消息 → 排队，当前 run 结束后合并进下一轮
- 以 `!` 开头的消息 → 直接作为 `steer` 写入当前 run

例如：

```text
再看一下 tests 目录
```

会在当前 run 结束后作为下一轮处理（绝不静默丢弃）；

```text
!先不要改代码，只分析原因
```

会直接进入当前 run 的 steer。

> 说明：早前版本把普通消息也作为 `follow_up` 直接写入当前 run，但 OMP 只在空闲时消化 follow_up，而桥接层在当前 turn 的 terminal 事件就拆除 run，导致处理中发送的普通消息可能被静默丢弃。现已改为普通消息可靠排队、仅 `!` 显式 steer。

## 前置条件

- Node.js `>= 20`
- pnpm
- 已安装并配置 Oh My Pi CLI，并确认：

```bash
omp --version
omp --mode rpc
```

- 一个飞书 / Lark PersonalAgent 应用。
- 如果需要让 OMP 继续使用传统飞书 CLI 工具，可按启动提示安装并绑定 `lark-cli`；host tools 不依赖 OMP 自己 shell 出 `lark-cli`。

## 快速开始

```bash
git clone https://github.com/Gyarados4157/feishu-omp-bridge.git
cd feishu-omp-bridge
pnpm install
pnpm build
node bin/feishu-omp-bridge.mjs run
```

不带子命令运行时，等价于 `run`：

```bash
node bin/feishu-omp-bridge.mjs
```

如果之后发布为 npm 包，CLI binary 名称是：

```bash
feishu-omp-bridge
```

## 首次启动向导

首次启动会检查配置并交互式引导：

1. 选择租户品牌：飞书或 Lark。
2. 输入 PersonalAgent App ID / App Secret。
3. 可选安装并绑定 `lark-cli`。
4. 写入 `~/.feishu-omp-bridge/config.json`。
5. App Secret 迁移到本地加密 keystore，避免明文留在配置文件中。

常用启动命令：

```bash
node bin/feishu-omp-bridge.mjs run
```

跳过 `lark-cli` 预检查：

```bash
node bin/feishu-omp-bridge.mjs run --skip-check-lark-cli
```

使用指定配置文件：

```bash
node bin/feishu-omp-bridge.mjs run -c /path/to/config.json
```

## 后台运行

```bash
node bin/feishu-omp-bridge.mjs start      # 注册（如需）并启动 OS 管理的后台 daemon
node bin/feishu-omp-bridge.mjs status     # 查看 daemon 状态、pid、日志路径
node bin/feishu-omp-bridge.mjs restart    # 重启 daemon
node bin/feishu-omp-bridge.mjs stop       # 停止 daemon，但保留注册文件
node bin/feishu-omp-bridge.mjs unregister # 删除 daemon 注册文件
```

后台实现：

| 平台 | 后台机制 | 标识 |
| --- | --- | --- |
| macOS | launchd user agent | `ai.feishu-omp-bridge.bot` |
| Linux | systemd user unit | `feishu-omp-bridge.bot.service` |
| Windows | Task Scheduler | `FeishuOmpBridge.Bot` |

macOS 额外说明：macOS 15+ 的**本地网络**隐私按进程身份放行，由 launchd 直接
拉起的 `node` 属于后台 CLI，既弹不出授权框、也不会出现在
设置 → 隐私与安全性 → 本地网络 列表里，导致 bridge 里执行的命令访问**同网段**
地址（例如公司内网 FTP / 局域网服务）被内核拒绝，报 `No route to host`
（Python 侧 `[Errno 65]`），而路由网段与公网正常 —— 同一个命令在终端里跑却没问题，
因为终端 app 早已获得该权限。因此 macOS 的 plist 不直接跑 `node`，而是先运行一个
supervisor app：

```bash
~/.feishu-omp-bridge/macos/FeishuOmpBridge.app/Contents/MacOS/FeishuOmpBridgeSupervisor \
    --marker ~/.feishu-omp-bridge/macos/local-network-granted -- \
    <node> <bridge entry> run
```

它由 `src/daemon/macos-supervisor.ts` 在 `start`/`restart` 时按需用 `xcrun swiftc`
编译并 `codesign`，把 `node` 作为子进程运行 —— 整棵进程树
（含 OMP 及其工具子进程）都归到 `ai.feishu-omp-bridge.supervisor` 这个 app 身份，
于是 macOS 只会弹**一次**「允许访问本地网络」（点允许后窗口自动关闭并写 marker），
之后内网访问长期有效。缺 `swiftc` 或签名身份时自动回退到直接跑 `node`（旧行为）。
若权限被系统收回（或用户手动关掉），删除
`~/.feishu-omp-bridge/macos/local-network-granted` 再 `restart` 即可重新触发授权。

签名身份**不写死**，按以下顺序决定，选定后写入
`~/.feishu-omp-bridge/macos/sign-identity` 固化（否则钥匙串顺序变化会导致重签、
进而丢失授权）：

1. 环境变量 `FOB_MACOS_SIGN_IDENTITY`（显式指定，值就是 `security find-identity
   -v -p codesigning` 里的名字，例如 `"Apple Development: you@example.com (XXXXXXXXXX)"`；
   设成 `-` / `ad-hoc` / `none` 表示不签名）；
2. 上面那个固化文件里记着的身份（仍存在于钥匙串时复用）；
3. 钥匙串里现有的 codesigning 身份，按「有效期长 → 短」优先：
   `Developer ID Application` > `Apple Development` > `Mac Developer`（同级保持钥匙串顺序）。

ad-hoc 签名（没有任何可用证书时）没有稳定身份：macOS 可能既不给弹窗也不给授权，
而且每次重编译都会变，需要重新授权 —— 此时用 `FOB_MACOS_SIGN_IDENTITY` 显式指定一个
证书即可（任意开发者证书都行，包括个人团队）。

进程级命令：

```bash
node bin/feishu-omp-bridge.mjs ps
node bin/feishu-omp-bridge.mjs kill <id|#>
```

## 配置文件

默认配置路径：

```text
~/.feishu-omp-bridge/config.json
```

典型结构：

```json
{
  "accounts": {
    "app": {
      "id": "cli_xxxxxxxxxxxxxxxx",
      "tenant": "feishu",
      "secret": {
        "source": "exec",
        "provider": "feishu-omp-bridge",
        "id": "app-cli_xxxxxxxxxxxxxxxx"
      }
    }
  },
  "secrets": {
    "providers": {
      "feishu-omp-bridge": {
        "source": "exec",
        "command": "~/.feishu-omp-bridge/secrets-getter"
      }
    }
  },
  "preferences": {
    "ompBinary": "omp",
    "ompSessionDir": "~/.feishu-omp-bridge/omp-sessions",
    "messageReply": "card",
    "showToolCalls": true,
    "maxConcurrentRuns": 10,
    "runIdleTimeoutMinutes": 0,
    "requireMentionInGroup": true
  }
}
```

### `preferences` 字段

| 字段 | 默认值 | 说明 |
| --- | --- | --- |
| `ompBinary` | `omp` | OMP 可执行文件名或绝对路径。 |
| `ompModel` | 未设置 | 传给 `omp --model`；留空由 OMP 自身配置决定。 |
| `ompThinking` | 未设置 | 传给 `omp --thinking`。 |
| `ompSessionDir` | `~/.feishu-omp-bridge/omp-sessions` | bridge 专用 OMP session 目录（支持 `~` 展开）。运行与 `/resume`、`/ctx`、`/search`、`/history`、`/rename` 等历史命令都读这里。 |
| `ompTools` | 未设置 | 传给 `omp --tools` 的逗号分隔工具白名单；留空使用 OMP 默认工具集。 |
| `messageReply` | `markdown` | `card`、`markdown` 或 `text`。推荐使用 `card` 以获得完整交互。 |
| `showToolCalls` | `true` | 是否展示工具调用过程。 |
| `maxConcurrentRuns` | `10` | 全局并发 OMP run 上限，范围按代码限制到最多 50。 |
| `runIdleTimeoutMinutes` | 关闭 | OMP 长时间无输出时的 idle kill 分钟数；`0` 或未设置表示关闭。 |
| `requireMentionInGroup` | `true` | 群聊是否必须 `@bot` 才响应；私聊不受影响。 |
| `agentStopGraceMs` | `5000` | OMP 进程收到停止信号后等待 SIGKILL 的毫秒数，限制在 100-30000。 |

### 访问控制

可在 `preferences.access` 中限制用户、群和管理员：

```json
{
  "preferences": {
    "access": {
      "allowedUsers": ["ou_xxx"],
      "allowedChats": ["oc_xxx"],
      "admins": ["ou_xxx"],
      "owner": "ou_xxx"
    }
  }
}
```

语义：

- `allowedUsers` 空或未设置：允许所有用户。
- `allowedChats` 空或未设置：允许所有 chat。
- `admins` 空或未设置：所有允许用户都可执行管理员命令。
- `owner` 未设置：回退到 `admins[0]`；两者都未设置时，高危命令对所有人拒绝。
- 管理员命令（`admins`）：`/account`、`/config`、`/model`、`/thinking`、`/restart`、`/context`、`/resume`、`/session`、`/every`、`/search`、`/history`、`/sessions`、`/work`、`/diff`、`/exit`、`/reconnect`、`/doctor`、`/cd`、`/ws`。
- 归属者命令（`owner`，比 admins 更严）：`/release`、`/exec`、`/run` —— 只有 owner 能跑，协作者拿 admin 也无法执行 shell。

## 数据目录

| 路径 | 用途 |
| --- | --- |
| `~/.feishu-omp-bridge/config.json` | App 凭据、secret refs、偏好配置。 |
| `~/.feishu-omp-bridge/secrets.enc` | 本地加密 secret keystore。 |
| `~/.feishu-omp-bridge/.keystore.salt` | keystore salt。 |
| `~/.feishu-omp-bridge/secrets-getter` | exec secret provider wrapper。 |
| `~/.feishu-omp-bridge/sessions.json` | v2：各 scope 的当前工作会话指针 + timeout 覆盖，以及全部工作会话（含各自有序的段）。旧文件加载时自动迁移（v1 备份为 `sessions.json.v1.bak`）。 |
| `~/.feishu-omp-bridge/omp-sessions/` | bridge 专用 OMP JSONL session 文件。 |
| `~/.feishu-omp-bridge/workspaces.json` | 命名工作空间。 |
| `~/.feishu-omp-bridge/processes.json` | 本机 bridge 进程注册表。 |
| `~/.feishu-omp-bridge/media/` | 下载的图片 / 文件缓存。 |
| `~/.feishu-omp-bridge/logs/` | 结构化日志和 daemon stdout/stderr 日志。 |

## 飞书聊天命令

| 命令 | 作用 |
| --- | --- |
| `/work [名字]` | 开启一件新工作（工作会话，唯一的分段边界）；子命令 `merge`/`split` 见「工作会话」。 |
| `/new`、`/reset` | 只重置上下文（同一工作会话里新起一段），不再换工作会话。 |
| `/new chat [name]` | 创建新群并拉你进去，继承当前 cwd。需要 bot 具备 `im:chat` 权限。 |
| `/cd <path>` | 切换当前 chat/topic 的工作目录（同一工作会话里新起一段，cwd 随段走）。支持绝对路径、`~/xxx`、相对当前目录的路径（如 `src`、`../x`）。 |
| `/ws list` | 查看命名工作空间。 |
| `/ws add <name> <path>` | 保存当前 cwd 为命名工作空间。 |
| `/ws use <name>` | 切换到命名工作空间（同一工作会话里新起一段）。 |
| `/config` | 打开偏好设置卡片。 |
| `/account` | 更换 bot app 凭据并重连。 |
| `/context` | 查看当前工作会话上下文(工作会话 id/段数/当前段/cwd/模型/探活等)。 |
| `/rename <标题>` | 给当前**工作会话**起名;`/rename auto` 用 LLM 生成(≤20 字),`/rename clear` 清除。标题显示在 `/context`、`/status`、`/resume`、`/search`。 |
| `/history [all]`、`/sessions` | 工作会话清单，按最后活动时间倒序：默认只看**当前工作目录**，`all` 看全部工作目录。每行 = 一个工作会话（活动时间 / 轮数 / 段数 / 标题或最后一条用户消息），「继续对话」恢复最新段，`/history seg <id>` 列出各段并单独恢复；超过 8 条分页。admin 命令。 |
| `/status` | 查看当前 scope、cwd、session、agent。 |
| `/stop` | 终止当前正在执行的 OMP run。 |
| `/timeout [N|off|default]` | 设置当前 session 的 idle timeout，或关闭 / 恢复全局默认。 |
| `/ps` | 列出本机所有 bridge 进程，并标识当前回复进程。 |
| `/release` | 自发布：`pnpm typecheck` → `pnpm test` → `pnpm build` 后重启 daemon 加载新代码。失败即中止、不重启。 |
| `/exec <命令>`、`/run` | 在当前 cwd 下执行 shell 命令并回退出码 + 输出（30s 超时，输出截断 1000 字符）。admin 命令。 |
| `/exit <id|#>` | 关闭指定 bridge 进程。 |
| `/reconnect` | 强制重连 WebSocket。 |
| `/doctor [描述]` | 把最近日志和故障描述交给 OMP 自助诊断。 |
| `/help` | 显示帮助卡片。 |

普通消息会直接交给 OMP。群聊默认需要 `@bot`；私聊不需要。

## 飞书卡片回调

bridge 会识别两类卡片回调：

1. bridge 自己的命令卡片，例如 `/config`、`/help`、OMP UI 卡片。
2. Agent 生成的 callback payload。为了兼容旧桥接层，内部 marker 仍保留 `__codex_cb` 字符串，但代码变量已经改为通用 agent callback 命名。

Agent callback 会被转成当前 scope 的 follow-up 消息，使 OMP 在同一个 session 中收到用户点击结果。

## OMP host tools 细节

### `feishu_current_context`

入参：无。

返回示例：

```json
{
  "scope": "oc_xxx:omt_xxx",
  "chatId": "oc_xxx",
  "threadId": "omt_xxx",
  "replyToMessageId": "om_xxx",
  "cwd": "/Users/me/project"
}
```

### `feishu_send_message`

入参：

```json
{
  "content": "Markdown 内容",
  "chatId": "可选，默认当前 chat"
}
```

行为：向目标 chat 发送 Markdown。若目标是当前 topic 所在 chat，会带上 thread reply 选项。

### `feishu_reply_message`

入参：

```json
{
  "content": "Markdown 回复内容",
  "messageId": "可选，默认触发本轮的消息"
}
```

行为：回复指定消息；在 topic 中会尽量保持 thread reply。

### `feishu_get_message`

入参：

```json
{
  "messageId": "om_xxx"
}
```

行为：读取并规范化指定飞书消息，适合让 OMP 查看引用消息、卡片来源或转发内容。

## `feishu://` URI

OMP 可读取：

```text
feishu://current/context
feishu://message/<message_id>
```

当前 scheme 只读。写操作会返回错误，避免 Agent 绕开 bridge 的消息发送工具和权限边界。

## 安全说明

- 不要提交 `~/.feishu-omp-bridge/config.json`、`secrets.enc`、日志或 session 文件。
- App Secret 默认迁移到本地加密 keystore；`config.json` 只保存 SecretRef。
- 本地 keystore 防止备份、误提交、日志泄漏中的明文暴露；它不是同用户进程级别的强隔离密钥库。
- OMP 可以运行本机工具，等价于把飞书消息授权给本地 Agent 执行。生产使用建议配置：
  - `preferences.access.allowedUsers`
  - `preferences.access.allowedChats`
  - `preferences.access.admins`
  - `ompTools` 工具白名单
  - 固定工作目录 / 命名工作空间
- 群聊默认必须 `@bot` 才响应，避免无意触发。
- `@全员` 不会触发响应。

## 开发

架构与代码组织约定见 [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)。

### 自更新 / 自愈

以下脚本位于 `scripts/`（随仓库分发），用于防止"周末 bot 自己更新后起不来"这类问题：

- **`scripts/self-update.py`** — 受控自更新：`git pull` → `typecheck` →
  `test` → `build` 全部通过才 `restart`；任一步失败自动回滚到旧 HEAD +
  恢复备份的 `dist/`，daemon 保持旧版本运行。原子锁防并发。
- **`scripts/self-heal.py`** — 自愈看门狗（launchd 常驻
  `ai.feishu-omp-bridge.heal`）：每 60s 探测「进程存活 + 服务在后台运行」。
  进程存活由三路独立信号取 OR（launchd 给的 pid / `processes.json` 里进程
  自写的 pid / `pgrep -f`），只有三路全部判死才算死；探针超时或信号矛盾一律
  算「判不出」，不计异常、不动手。连续 3 次**确认**异常后先复检一次，仍判死
  才 `restart`，仍失败则唤起一个 omp 会话带日志上下文诊断修复（并发锁 +
  阶梯退避 + 最大 10 次上限 + 提示词退出契约）。
  - 安装：`scripts/self-heal.py install`；卸载：`uninstall`
  - 手动一轮：`scripts/self-heal.py --once`

自更新 / 自愈均有 pytest 测试（隔离环境，不影响生产）：
  - `scripts/test_self_heal.py` — 27 场景：健康不误报 / 进程死自愈 /
    断连自愈 / pgrep 假阴性不动手 / 探针超时判不出不动手 / status 超时不算
    健康 / 动手前复检 / omp 不可用判异常 / restart 失败唤起 omp / 锁互斥 /
    退避 / omp 并发锁 / 修复闭环 / 最大次数上限 / 提示词契约 / rollback
    （含 build 超时恢复原 HEAD）/ SIGKILL 锁释放
  - `scripts/test_self_update.py` — 6 场景：更新成功 / typecheck / test /
    build / restart 任一失败回滚 / 锁互斥
  运行：`pnpm test:self-heal`（或 `python3 -m pytest scripts/test_self_heal.py scripts/test_self_update.py`）。
  需要 pytest：`python3 -m pip install --user pytest`。

另外，`src/daemon/launchd.ts` 生成的 plist 带 `ThrottleInterval=10`（崩溃后
防重启风暴），且 `start`/`restart` 若 30s 内连不上飞书会以非零码退出
（触发 launchd 重试）；设 `SELF_HEAL=1` 时还会自动唤起 omp 修复。

安装依赖：

```bash
pnpm install
```

开发 watch：

```bash
pnpm dev
```

类型检查：

```bash
pnpm typecheck
```

测试：

```bash
pnpm test
```

构建：

```bash
pnpm build
```

查看 CLI：

```bash
node bin/feishu-omp-bridge.mjs --help
```

## 验证状态

本仓库当前代码层验证覆盖：

- OMP RPC adapter 参数、事件翻译、session/run 生命周期。
- OMP 原生 UI request/response。
- OMP host tool / host URI callback。
- active run 的 UI response 与 mid-run prompt 路由。
- 配置 schema。
- run-state reducer 与飞书卡片相关逻辑。

常规验证命令：

```bash
pnpm typecheck
pnpm test
pnpm build
```

真实飞书端到端验证需要可用的 PersonalAgent 凭据和实际飞书会话环境。

## 故障排查

| 问题 | 处理 |
| --- | --- |
| 启动时报找不到 `omp` | 确认 `omp --version` 可用，并先运行一次 `omp` 完成模型 / 认证配置。 |
| OMP RPC 启动后无响应 | 单独运行 `omp --mode rpc` 做 smoke test；检查 `~/.feishu-omp-bridge/logs/`。 |
| OMP 没有续上次对话 | 发 `/context` 看工作会话与「当前段」；cwd 变化会让 bridge 在同一工作会话里新起一段。 |
| 历史会话没归到同一件工作 | 先 `bridge migrate work-sessions`（dry-run）看回填计划，`--apply` 落盘后可用 `/work merge|split` 手工修正。 |
| 群聊无响应 | 确认消息里 `@bot`，或在 `/config` / `config.json` 中调整 `requireMentionInGroup`。 |
| 卡片长时间不动 | 用 `/stop` 中断；也可设置 `/timeout 10` 开启当前 session idle 探活。 |
| OMP 等待选择 / 输入 | 回复单独出现的“OMP 交互”卡片；等待期间 idle watchdog 会暂停。 |
| 飞书 API 工具不可用 | 按启动提示安装并绑定 `lark-cli`；或者优先使用已注册的 Feishu host tools。 |
| `/new chat` 失败 | 确认 bot 具备创建群相关权限，代码中该能力依赖 `im:chat`。 |
| 后台 daemon 不工作 | 运行 `node bin/feishu-omp-bridge.mjs status` 查看服务状态和日志路径。 |
| **`cmux ping` 报「访问被拒绝 / Access denied」** | cmux 默认 `socketControlMode=cmuxOnly`，只允许 **cmux 内启动**的进程；改成 **`Automation`**（Settings → Automation）。详见 [`docs/CMUX-AGENT-INTERACTION.md`](docs/CMUX-AGENT-INTERACTION.md) §1。 |
| **往 cmux 里的 pi 发消息没反应** | 目标忙时消息会进 `Steering:` 队列（等当前 turn 结束才消费），不是失败；验证请看 pi 的 session JSONL。同上 §5。 |
| **`cmux send-key` 超时 / 无效** | 锁屏场景下 `send-key` 不可靠（键名支持不全 + 间歇超时）；**一律改用 `cmux send`**（Enter 用 `'\r'`）。同上 §3。 |
| **往 kimi 面板投递多行消息后指令被重复执行** | `cmux paste-buffer` 会把消息最后 1–2 行**留在输入框**，回合结束时会**再投一次**。投递后必做：`send-key <ws> Up`（取回残留）→ `send-key <ws> backspace` ×N → `read-screen` 确认输入框为空。同上 §11.5。 |
| **以为 cmux 里的 agent「没在动」** | cmux 面板标题取自**会话最初标题**、不随当前动作变化；判断活跃度要看 session 落盘文件（kimi：`state.json` + `agents/main/wire.jsonl` 的 mtime）。同上 §12.3 / §12.7-1。 |
| **`cmux send-key` 用 `C-u` 报 `Unknown key`** | 组合键要写成 `control-u` / `ctrl-u`（不接受 `C-`/`M-` 缩写）；键名清单与副作用（`shift-tab` 疑似 kimi Plan mode 开关）见同上 §11.3 / §11.4。 |
| **想一次看所有 cmux 窗口的状态** | 读 `~/Library/Application Support/cmux/session-com.cmuxterm.app.json`（含每个面板的最新通知，agent 完成通知也在里面），比逐个 `read-screen` 快且不受锁屏影响。同上 §11.6。 |
| **面板从不出 agent 通知**（`Cursor is waiting for you` 等） | 通知由 cmux 的 agent hook 产生（`~/.orca/agent-hooks/<agent>-hook.sh` → POST `127.0.0.1:$ORCA_AGENT_HOOK_PORT`）：**只有从 cmux 面板内启动的 agent 才有 `ORCA_*` 环境变量**，外部（launchd/bridge）启动的不会有通知；另检查 hook 文件可执行、agent 配置里有 hook 条目（`~/.cursor/hooks.json`、`~/.kimi-code/config.toml`）。同上 §14。 |
| **要驱动 Cursor Agent** | 优先用**非交互通道**：`cursor-agent -p "<prompt>" --output-format json`（`-p` 默认带写/shell 权限，无人值守请配 `--mode plan` 或 `--sandbox enabled`）；会话在 `~/.cursor/chats/<hash>/<chatId>/store.db`（SQLite，判活看 mtime/size）。同上 §13。 |

## 相关文档

| 文档 | 内容 |
| --- | --- |
| [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) | 本仓库架构、数据流、目录结构、命令组织约定 |
| [`docs/CMUX-AGENT-INTERACTION.md`](docs/CMUX-AGENT-INTERACTION.md) | **从 bridge 远程驱动 cmux / pi / kimi / Cursor 的实测手册**：cmux 权限开启（`socketControlMode`）、锁屏能力矩阵与踩坑、`send` vs `send-key`、pi/omp 差异、消息投递语义（idle 直投 vs busy 排队）、不依赖读屏的 session 验证法；**§11 cmux CLI 通用补充**（workspace/panel 定位、键名清单与副作用、`paste-buffer` 残留排队行的清理）；**§12 kimi（Kimi Code）**；**§13 Cursor（cursor-agent）**（多版本 CLI、SQLite 会话库、`-p` 非交互通道）；**§14 agent 通知机制**（`~/.orca/agent-hooks` ⇄ cmux 通知） |

## 当前限制

- 当前 Feishu host URI 只支持 `current/context` 和 `message/<message_id>`。
- `feishu://` 只读；发送消息请使用 `feishu_send_message` 或 `feishu_reply_message`。
- 真实飞书端到端能力取决于 PersonalAgent 权限、租户策略和网络环境。
- OMP SDK 深集成尚未启用；当前主路径是更稳定、易调试、进程隔离更清晰的 `omp --mode rpc`。

## License

MIT
