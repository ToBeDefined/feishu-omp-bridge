# feishu-omp-bridge

把飞书 / Lark 消息和本地 Oh My Pi CLI 打通的轻量 bot。飞书消息会进入 `omp --mode rpc`，结果以卡片或 Markdown 流式回到飞书，并按 chat / topic 维度隔离保存 OMP 会话。

## 能干什么

- 在飞书私聊、群聊 `@bot`、话题群 topic、云文档评论 `@bot` 中把消息转给本地 OMP。
- 流式卡片展示 OMP 文本、thinking、工具调用、工具更新和工具输出。
- 把 OMP 原生 UI 请求（`confirm`、`select`、`input`、`editor`）映射成飞书交互卡片，并把用户选择实时写回同一个 RPC run。
- 在飞书输出里展示 OMP extension 的 `notify`、`setStatus`、`setWidget`、`setTitle`、`set_editor_text` 和 `open_url` 事件。
- 注册飞书原生 OMP host tools（`feishu_current_context`、`feishu_send_message`、`feishu_reply_message`、`feishu_get_message`），让 OMP 不经 `lark-cli` 也能直接使用飞书能力。
- 注册只读 `feishu://` host URI scheme，例如 `feishu://current/context` 和 `feishu://message/<message_id>`。
- OMP 运行中同一 chat/topic 再发消息会安全排队，当前 run 结束后合并进下一轮（不丢失）；消息以 `!` 开头则直接作为 `steer` 进入当前 run。
- 每个 chat / topic 保存自己的 OMP session id，下一轮自动用 `omp --mode rpc --resume <session_id>` 继续。
- 保留 bridge 命令：`/new`、`/cd`、`/ws`、`/status`、`/config`、`/stop`、`/timeout`、`/ps`、`/exit`、`/reconnect`、`/doctor`、`/rename`（给会话起名，`/rename auto` 用 LLM 生成）。
- 图片 / 文件会下载到本地路径；图片会转成 OMP RPC image payload。
- OMP 可以继续使用本机可用工具，例如 `lark-cli`、`git`、项目测试命令等。

## 前置条件

- Node.js 20+
- pnpm（源码开发 / 本地构建时使用）
- 已安装并配置 Oh My Pi CLI：先运行一次 `omp`，并确认 `omp --mode rpc` 可用。
- 一个飞书 / Lark PersonalAgent 应用；首次启动向导会协助配置。

## 安装 / 构建

```bash
pnpm install
pnpm build
```

本地开发：

```bash
pnpm dev
```

如果作为包安装，CLI 名称是：

```bash
feishu-omp-bridge
```

不带子命令时默认等价于 `feishu-omp-bridge run`。

## 首次启动

```bash
feishu-omp-bridge
```

首次启动会检查配置并引导完成：

1. 选择飞书或 Lark 租户。
2. 填入 PersonalAgent App ID / App Secret。
3. 可选安装并绑定 `lark-cli`，供 OMP 调用飞书 API 工具。
4. 凭据写入 `~/.feishu-omp-bridge/config.json`，密钥加密保存在本地 keystore。

## CLI 命令

```bash
feishu-omp-bridge run [-c <config>]     前台启动 bot
feishu-omp-bridge ps                    列出本机所有正在跑的 bridge 进程
feishu-omp-bridge kill <id|#>           kill 指定 bridge 进程
feishu-omp-bridge secrets <subcommand>  管理本地加密 secret keystore
feishu-omp-bridge --help                列出所有命令
```

### 后台 daemon

```bash
feishu-omp-bridge start                 注册（如需）+ 启动后台 daemon
feishu-omp-bridge stop                  停止 daemon 并关闭开机自启
feishu-omp-bridge restart               重启 daemon
feishu-omp-bridge status                查看 daemon 状态和日志路径
feishu-omp-bridge unregister            删除 daemon 注册文件
```

后台机制：

- macOS：launchd user agent `ai.feishu-omp-bridge.bot`
- Linux：systemd 用户单元 `feishu-omp-bridge.bot.service`
- Windows：Task Scheduler 任务 `FeishuOmpBridge.Bot`

## 飞书聊天命令

| 命令 | 作用 |
| --- | --- |
| `/new`、`/reset` | 清空当前 chat / topic 的 OMP session，下一条消息新建会话。 |
| `/new chat [name]` | 新建群并拉你进去，继承当前 cwd。 |
| `/cd <path>` | 切换当前 chat / topic 的工作目录；会重置 session。支持绝对路径、`~/xxx`、相对当前目录的路径（如 `src`、`../x`）。 |
| `/ws list` | 查看命名工作空间。 |
| `/ws add <name> <path>` | 保存命名工作空间。 |
| `/ws use <name>` | 切换到命名工作空间并重置 session。 |
| `/config` | 打开偏好设置卡片。 |
| `/account` | 更换 bot app 凭据并重连。 |
| `/status` | 查看当前 scope、cwd、session、agent。 |
| `/stop` | 终止当前正在跑的 OMP 任务。 |
| `/timeout [N|off|default]` | 设置当前 session 的 idle 探活分钟数，或关闭 / 恢复全局默认。 |
| `/ps` | 列出本机所有 bot，并标识当前正在回复的进程。 |
| `/release` | 自发布：`pnpm typecheck` → `pnpm test` → `pnpm build` 后重启 daemon 加载新代码。失败即中止、不重启。 |
| `/exec <命令>` | 在当前 cwd 下执行 shell 命令并回退出码 + 输出（30s 超时，输出截断 1000 字符）。admin 命令。 |
| `/exit <id|#>` | 关闭指定 bot 进程。 |
| `/reconnect` | 强制重连 WebSocket。 |
| `/doctor [描述]` | 把最近日志和故障描述交给 OMP 自助诊断。 |
| `/help` | 显示帮助卡片。 |

其他普通消息会直接交给 OMP。群聊默认需要 `@bot`；私聊不需要。

## 数据目录

| 路径 | 用途 |
| --- | --- |
| `~/.feishu-omp-bridge/config.json` | App 凭据、secret refs、偏好配置。 |
| `~/.feishu-omp-bridge/secrets.enc` | 本地加密 secret keystore。 |
| `~/.feishu-omp-bridge/sessions.json` | 每个 chat / topic 的 OMP session id、cwd 和可选 timeout 覆盖。 |
| `~/.feishu-omp-bridge/omp-sessions/` | bridge 专用 OMP JSONL session 文件。 |
| `~/.feishu-omp-bridge/workspaces.json` | 命名工作空间映射。 |
| `~/.feishu-omp-bridge/processes.json` | 当前运行的 bridge 进程注册表。 |
| `~/.feishu-omp-bridge/media/` | 下载的图片 / 文件缓存。 |
| `~/.feishu-omp-bridge/logs/` | 结构化日志和 daemon stdout/stderr 日志。 |

## OMP 偏好配置

可在 `config.json` 的 `preferences` 中设置：

```json
{
  "preferences": {
    "ompBinary": "omp",
    "ompModel": "gpt-5.5",
    "ompThinking": "xhigh",
    "ompSessionDir": "~/.feishu-omp-bridge/omp-sessions",
    "ompTools": "read,bash,edit,write",
    "messageReply": "markdown",
    "showToolCalls": true,
    "maxConcurrentRuns": 10,
    "runIdleTimeoutMinutes": 0,
    "requireMentionInGroup": true
  }
}
```

- `ompBinary`：OMP 可执行文件名或绝对路径，默认 `omp`。
- `ompModel`：传给 `omp --model` 的模型；留空则由 OMP 自身配置决定。
- `ompThinking`：传给 `omp --thinking` 的思考级别；留空则由 OMP 自身配置决定。
- `ompSessionDir`：本 bridge 使用的 OMP session 目录；默认 `~/.feishu-omp-bridge/omp-sessions`。
- `ompTools`：传给 `omp --tools` 的逗号分隔工具白名单；留空则启用 OMP 默认工具集。
- `messageReply`：`card`、`markdown` 或 `text`。
- `showToolCalls`：是否在卡片 / Markdown 中展示工具调用过程。

## 飞书原生 OMP host 能力

bridge 启动的每个 OMP run 都会注册这些 host tools：

| Tool | 用途 |
| --- | --- |
| `feishu_current_context` | 返回当前 scope、chat、topic、触发消息和 cwd。 |
| `feishu_send_message` | 向当前 chat 或显式 `chatId` 发送 Markdown。 |
| `feishu_reply_message` | 回复触发消息或显式 `messageId`。 |
| `feishu_get_message` | 按 `messageId` 拉取并规范化飞书消息。 |

bridge 还会注册只读 `feishu://` host URI：

- `feishu://current/context`
- `feishu://message/<message_id>`

同一 chat/topic 在 OMP 运行中继续发消息时，会安全排队并在当前 run 结束后合并进下一轮，不会静默丢失；消息以 `!` 开头时会直接作为 `steer` 发送到当前 run。

旧配置里的 `codexBinary` 和 `codexModel` 仍会作为 fallback 读取，便于旧配置启动后手动迁移。

## 故障排查

- `run` 启动时报找不到 `omp`：确认 `omp --version` 可用，并先运行一次 `omp` 完成模型 / 认证配置。
- OMP 没有继续上次对话：发 `/status` 查看 cwd 和 session；cwd 变化会让 bridge 自动新建 session。
- 群聊没响应：确认消息里 `@bot`，或在 `/config` 里调整群聊 mention 策略。
- 卡片长时间不动：可用 `/stop` 终止当前任务，或用 `/timeout 10` 为当前 session 开启 idle 探活。
- OMP 等待选择 / 输入时：直接回复单独出现的“OMP 交互”卡片；该请求挂起期间 idle watchdog 会暂停。
- 飞书 API 工具不可用：按启动提示安装并绑定 `lark-cli`。
