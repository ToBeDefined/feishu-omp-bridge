# agent 通知机制：~/.orca/agent-hooks ⇄ cmux 通知（§1）
> 章节号为本文件自编号（1 起）；跨文件引用写作「文件名 §x.y」。SKILL.md 主入口见 ../SKILL.md。

## 1. agent 通知机制：`~/.orca/agent-hooks` ⇄ cmux 通知

**问题**：cmux 面板为什么会冒出 `Cursor is waiting for you`、`Kimi Code task complete: …`？
**答案**：cmux 的 agent 集成层（代号 **orca**）往每个 agent 里装了 **hook 脚本**；agent 在生命周期事件上调用它，脚本把 payload POST 回本机端口，cmux 再生成**面板通知**。

### 1.1 组件與落点

| 组件 | 实测位置 |
|---|---|
| hook 脚本 | `~/.orca/agent-hooks/<agent>-hook.sh` —— 实测 **11 个**：`antigravity` / `claude` / `codex` / `command-code` / `copilot` / **`cursor`** / `devin` / `droid` / `gemini` / `grok` / **`kimi`** / `openclaude` |
| 安装落点（Cursor） | `~/.cursor/hooks.json`（`afterAgentResponse`、`beforeSubmitPrompt`、`beforeShellExecution`、`beforeMCPExecution` …） |
| 安装落点（kimi） | `~/.kimi-code/config.toml` 的 `[[hooks]]` |
| 投递端点 | `http://127.0.0.1:${ORCA_AGENT_HOOK_PORT}/hook/<agent>`，带 `X-Orca-Agent-Hook-Token: ${ORCA_AGENT_HOOK_TOKEN}` |
| 环境注入 | `ORCA_AGENT_HOOK_PORT` / `ORCA_AGENT_HOOK_TOKEN` / `ORCA_PANE_KEY` / `ORCA_TAB_ID` / `ORCA_AGENT_LAUNCH_TOKEN` / `ORCA_WORKTREE_ID` / `ORCA_AGENT_HOOK_ENV` / `ORCA_AGENT_HOOK_VERSION`（由 cmux pane 注入；kimi 的脚本还会 source `$ORCA_AGENT_HOOK_ENDPOINT`） |
| 安装命令 | `cmux hooks setup`（会先列出将写入哪些 agent 配置） |
| 通知落点 | cmux session JSON 的 `panels[].notifications[]`（`title` / `body` / `createdAt` / `scrollPosition`）⇒ **cli-basics.md §3.7 的脚本可直接读到** |

### 1.2 hook 脚本长什么样（`cursor-hook.sh` 截取）

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

1. **只有「从 cmux 面板内启动」的 agent 才有 `ORCA_*` 环境变量** —— 与 cli-basics.md §1.1 的 `socketControlMode` 是**两条独立链路**。
   ⇒ **外部进程（如 bridge、launchd）启动的 agent 不会产生 cmux 通知**；反过来，通知存在即说明该 agent 跑在 cmux 面板里。
2. hook 有 0.5–1.5 s 超时且末尾 `|| true` ⇒ **不会阻塞 agent**，hook 失败也静默。

### 1.3 排查表

| 症状 | 检查 |
|---|---|
| 面板从不出通知 | ① hook 文件存在且可执行（`ls -l ~/.orca/agent-hooks/<agent>-hook.sh`）；② agent 配置里有 hook 条目（`~/.cursor/hooks.json`、`~/.kimi-code/config.toml`）；③ **agent 是否从 cmux 内启动** |
| 通知重复 / 未读堆积 | `cmux list-notifications`、`cmux mark-notification-read --all`、`cmux clear-notifications`；历史见 `~/Library/Application Support/cmux/notification-feed-history-com.cmuxterm.app.json` |
| 想主动推状态 | `cmux notify [--title …] [--body …] [--reply]`、`cmux set-status <key> <value>`、`cmux set-progress <0..1>` |
| 长时间没更新的面板 | 看 `panels[].notifications[].createdAt`（cli-basics.md §3.7），比读屏更快判断「最后一次动是什么时候」 |
