# feishu-omp-bridge

[English](README.md) | [中文](README.zh.md)

A bridge that plugs Feishu / Lark messages into the local Oh My Pi CLI. It forwards messages from DMs, group chats, topic groups and cloud-doc comments to `omp --mode rpc`, then streams OMP's text, thinking, tool calls, tool deltas, native UI interactions and results back to Feishu.

## Positioning

`feishu-omp-bridge` does not re-implement a Feishu bot framework. It connects an existing Feishu/Lark bridging layer with OMP's RPC agent surface:

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

It fits these situations:

- Driving your local OMP from Feishu: read and write project files, run commands, analyze logs, fix code.
- Letting a team share one resumable OMP session through a Feishu group / topic group.
- Completing OMP's native `confirm` / `select` / `input` / `editor` UI inside Feishu interactive cards.
- Exposing Feishu context to the agent as OMP host tools / host URIs, instead of having the agent shell out to `lark-cli`.

## Core capabilities

### Messages and sessions

- Feishu / Lark DMs, plain group chats with `@bot`, topic groups, and cloud-doc comments with `@bot`.
- Every chat / topic stores its own **current session**; the next turn continues it with `omp --mode rpc --resume <session_id>`.
- Topic groups isolate session, cwd, pending queue and active run by `chatId:threadId`.
- Image input: Feishu images are downloaded into the local cache and turned into an OMP RPC image payload.
- File downloads are cached so OMP can read them later by local path.
- Message debounce: messages sent in quick succession are merged into one batch prompt.

### Session model

**One OMP session = one conversation.** The bridge only remembers the *current session* per chat/topic and `--resume`s it on the next turn; when that fails (or when you deliberately start a new one) a fresh conversation begins, and the old one stays in `/history` untouched.

- These switch to a new OMP session (= a new conversation): `/new` (`/reset`), `/cd`, `/ws use` (including `/ws undo`), and runtime drift (cwd changed / session file deleted / the old session can no longer be `--resume`d).
- These do **not** switch sessions: a `/release` restart and `/compact` (both keep running in the same conversation).
- **The cwd travels with the session**: resuming a conversation runs it in *its own* directory (the window's cwd follows it); only when there is no current session (after `/new`, `/cd`, `/ws use`) does the window's cwd decide where the new conversation lands. The default view of `/history` and the `/ctx`, `/status`, `/diff`, `/compact`, `/exec` commands all use this rule.
- A title belongs to **that conversation**: `/rename` names the current one; without a name, `/history`, `/search` and `/resume` fall back to its last user message.
- One `/history` row = one conversation (activity time / turn count / title or last user message); “Continue chat” restores it, and `/history all` covers every working directory.
- Upgrade note: early versions hung multiple OMP sessions under one “work session” (requiring manual merge/split). Old files are now normalized on load into “one conversation per session”, with a `sessions.json.v2.bak` kept.

### OMP RPC streaming output

- Streams OMP text output.
- Shows thinking / reasoning fragments.
- Shows tool-call starts, incremental updates and final results.
- Shows token usage (when OMP RPC reports usage).
- Supports interruption: `/stop` sends `abort` to OMP and then terminates the process after a grace period.

### OMP native UI → Feishu interactive cards

OMP RPC extension UI requests are mapped to Feishu cards, and the user's answer is written back to the same live RPC run:

| OMP UI method | Feishu rendering | Written back to OMP |
| --- | --- | --- |
| `confirm` | Confirm / No / Cancel buttons | `extension_ui_response` |
| `select` | Dropdown + Submit / Cancel | `extension_ui_response` |
| `input` | Single-line input + Submit / Cancel | `extension_ui_response` |
| `editor` | Multi-line input + Submit / Cancel | `extension_ui_response` |

Non-blocking UI events render into the run card or the text output:

- `notify`
- `setStatus`
- `setWidget`
- `setTitle`
- `set_editor_text`
- `open_url`

While OMP is waiting for a UI response the idle watchdog is paused; it resumes probing after the user submits or cancels, so a run waiting on a human is never killed by mistake.

### Feishu-native OMP host surface

Every OMP run registers Feishu host tools:

| Tool | Purpose |
| --- | --- |
| `feishu_current_context` | Returns the current scope, chat, topic, triggering message and cwd. |
| `feishu_send_message` | Sends Markdown to the current chat or an explicit `chatId`. |
| `feishu_reply_message` | Replies to the triggering message or an explicit `messageId`. |
| `feishu_get_message` | Fetches and normalizes a Feishu message by `messageId`. |
| `feishu_send_file` | Uploads a local file / image and sends it to the current chat or an explicit `chatId`. |
| `feishu_send_card` | Sends an interactive card from a title + markdown body + button list; clicks come back as `[card-click]` through `__codex_cb`. |
| `feishu_recall_message` | Recalls a message the bot itself sent. |
| `feishu_view_image` | Injects a local image into the current run so the model can look at it. |

A read-only `feishu://` host URI scheme is registered as well:

- `feishu://current/context`
- `feishu://message/<message_id>`

This lets OMP use Feishu **message-surface** resources (send/receive, history, cards, files) through structured host callbacks instead of making the model assemble `lark-cli` commands in a shell. The bridge owns permissions, current context, message parsing and result formatting.

**Access boundary** (so prompt injection cannot turn the host tools into an exfiltration channel):

- An explicit `chatId` only takes effect when `preferences.access.allowedChats` allows it (unset =
  unrestricted); out-of-range requests fail with a clear error instead of sending silently.
- The `path` argument of `feishu_send_file` / `feishu_view_image` is restricted to the session cwd,
  the media cache directory and the temp directory (after resolving symlinks); everything else is
  refused — nothing under `~/.feishu-omp-bridge/` (config.json / keystore) or anywhere else in
  `$HOME` can be sent out. To send a file from elsewhere, have the agent copy it into the cwd first.

> **Capability boundary**: the bridge only wraps the IM message surface. The wider Feishu ecosystem
> (docs / sheets / Base / calendar / meetings / approvals …) is **not** re-implemented — when the
> agent needs it, it calls `lark-cli` (or the matching lark-* skill) directly; the bridge does not
> build a second wrapper.

### Mid-run follow-up / steer

When an OMP run is already executing for a chat/topic, new plain messages in the same scope are **not lost**: they enter the pending queue and are merged into the next turn once the current run ends (flushed after 600 ms of silence). Only messages starting with `!` are written into the current RPC run as a steer:

- plain message → queued, merged into the next turn after the current run ends
- message starting with `!` → written into the current run as a `steer`

For example:

```text
also take a look at the tests directory
```

is handled as the next turn once the current run ends (never silently dropped);

```text
!don't change the code yet, just analyze the cause
```

goes straight into the current run as a steer.

> Note: earlier versions wrote plain messages into the current run as `follow_up`, but OMP only
> consumes follow-ups while idle, and the bridge tore the run down on the terminal event of the
> current turn — so a plain message sent mid-run could be silently dropped. Now plain messages are
> queued reliably and only `!` steers explicitly.

## Prerequisites

- Node.js `>= 20`
- pnpm
- Oh My Pi CLI installed and configured, verified with:

```bash
omp --version
omp --mode rpc
```

- A Feishu / Lark PersonalAgent app.
- If you want OMP to keep using the traditional Feishu CLI tooling, install and bind `lark-cli` when the startup prompt offers it; the host tools do not depend on OMP shelling out to `lark-cli`.

## Quick start

```bash
git clone https://github.com/Gyarados4157/feishu-omp-bridge.git
cd feishu-omp-bridge
pnpm install
pnpm build
node bin/feishu-omp-bridge.mjs run
```

Running without a subcommand is equivalent to `run`:

```bash
node bin/feishu-omp-bridge.mjs
```

Once published to npm, the CLI binary name is:

```bash
feishu-omp-bridge
```

## First-run wizard

The first start checks the configuration and walks you through:

1. Pick the tenant brand: Feishu or Lark.
2. Enter the PersonalAgent App ID / App Secret.
3. Optionally install and bind `lark-cli`.
4. Write `~/.feishu-omp-bridge/config.json`.
5. Move the App Secret into the local encrypted keystore so it never sits in plaintext in the config file.

Common startup commands:

```bash
node bin/feishu-omp-bridge.mjs run
```

Skip the `lark-cli` pre-flight check:

```bash
node bin/feishu-omp-bridge.mjs run --skip-check-lark-cli
```

Use a specific config file:

```bash
node bin/feishu-omp-bridge.mjs run -c /path/to/config.json
```

## CLI reference

```bash
feishu-omp-bridge run [-c <config>] [--skip-check-lark-cli]   # foreground bot (same as no subcommand)
feishu-omp-bridge start        # install (if needed) and start the OS-managed daemon
feishu-omp-bridge status       # daemon status, pid, last exit, log paths
feishu-omp-bridge restart      # restart the daemon
feishu-omp-bridge stop         # stop the daemon (registration files stay)
feishu-omp-bridge unregister   # remove the daemon registration (bootout + delete plist)
feishu-omp-bridge release      # typecheck → test → build, then restart the daemon
feishu-omp-bridge ps           # list running bridge processes on this machine
feishu-omp-bridge kill <id|#>  # kill a bridge process (SIGTERM, then SIGKILL after 2s)
feishu-omp-bridge secrets get|set|list|remove   # inspect / manage the encrypted secret keystore
feishu-omp-bridge migrate      # migrate legacy config paths/shape (idempotent no-op when done)
feishu-omp-bridge -v, --version
```

Process-level commands (`ps`, `kill`) act on running bridge processes; service-level commands
(`start`, `stop`, `restart`, `status`, `unregister`, `release`) act on the OS-managed daemon.

## Background daemon

```bash
node bin/feishu-omp-bridge.mjs start      # register (if needed) and start the OS-managed daemon
node bin/feishu-omp-bridge.mjs status     # daemon status, pid, log paths
node bin/feishu-omp-bridge.mjs restart    # restart the daemon
node bin/feishu-omp-bridge.mjs stop       # stop the daemon, keep the registration files
node bin/feishu-omp-bridge.mjs unregister # delete the daemon registration files
```

Background implementations:

| Platform | Background mechanism | Identifier |
| --- | --- | --- |
| macOS | launchd user agent | `ai.feishu-omp-bridge.bot` |
| Linux | systemd user unit | `feishu-omp-bridge.bot.service` |
| Windows | Task Scheduler | `FeishuOmpBridge.Bot` |

macOS extra note: on macOS 15+ the **Local Network** privacy prompt is granted per process
identity. A `node` launched directly by launchd counts as a background CLI: it can neither show the
prompt nor appear in System Settings → Privacy & Security → Local Network, so commands the bridge
runs against **same-subnet** addresses (an intranet FTP server, a LAN service) get rejected by the
kernel with `No route to host` (Python: `[Errno 65]`), while routed subnets and the public internet
work fine — and the very same command runs fine in a terminal, because the terminal app already has
that permission. The macOS plist therefore does not run `node` directly but starts a supervisor app
first:

```bash
~/.feishu-omp-bridge/macos/FeishuOmpBridge.app/Contents/MacOS/FeishuOmpBridgeSupervisor \
    --marker ~/.feishu-omp-bridge/macos/local-network-granted -- \
    <node> <bridge entry> run
```

`src/daemon/macos-supervisor.ts` compiles it on demand with `xcrun swiftc` and `codesign`s it during
`start`/`restart`, then runs `node` as a child process — the whole process tree (including OMP and
its tool subprocesses) belongs to the `ai.feishu-omp-bridge.supervisor` app identity, so macOS shows
the “allow local network access” prompt **once** (the window closes itself after you allow it and a
marker is written) and intranet access keeps working afterwards. When `swiftc` or a signing identity
is missing it falls back to running `node` directly (the old behavior). If the permission is revoked
(or you turn it off manually), delete `~/.feishu-omp-bridge/macos/local-network-granted` and
`restart` to trigger the prompt again.

The signing identity is **not hard-coded**; it is chosen in this order and then frozen into
`~/.feishu-omp-bridge/macos/sign-identity` (otherwise a change in keychain order causes a re-sign and
loses the grant):

1. The `FOB_MACOS_SIGN_IDENTITY` environment variable (an explicit choice — the value is the name
   from `security find-identity -v -p codesigning`, e.g.
   `"Apple Development: you@example.com (XXXXXXXXXX)"`; set it to `-` / `ad-hoc` / `none` to skip
   signing);
2. The identity recorded in that frozen file (reused while it still exists in the keychain);
3. An existing codesigning identity in the keychain, preferring the longer validity:
   `Developer ID Application` > `Apple Development` > `Mac Developer` (same tier keeps keychain order).

An ad-hoc signature (when no usable certificate exists) has no stable identity: macOS may neither
prompt nor grant, and every rebuild changes it, so you have to re-authorize — set
`FOB_MACOS_SIGN_IDENTITY` to an explicit certificate in that case (any developer certificate works,
including a personal team).

Process-level commands:

```bash
node bin/feishu-omp-bridge.mjs ps
node bin/feishu-omp-bridge.mjs kill <id|#>
```

## Configuration file

Default config path:

```text
~/.feishu-omp-bridge/config.json
```

Typical shape:

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

### `preferences` fields

| Field | Default | Description |
| --- | --- | --- |
| `ompBinary` | `omp` | OMP executable name or absolute path. |
| `ompModel` | unset | Passed to `omp --model`; left empty, OMP's own config decides. |
| `ompThinking` | unset | Passed to `omp --thinking`. |
| `ompSessionDir` | `~/.feishu-omp-bridge/omp-sessions` | Bridge-only OMP session directory (`~` is expanded). Running and the `/resume`, `/ctx`, `/search`, `/history`, `/rename` history commands all read it. |
| `ompTools` | unset | Comma-separated tool allowlist passed to `omp --tools`; empty uses OMP's default tool set. |
| `messageReply` | `markdown` | `card`, `markdown` or `text`. `card` is recommended for full interactivity. |
| `showToolCalls` | `true` | Whether to show the tool-call process. |
| `maxConcurrentRuns` | `10` | Global OMP run concurrency limit; the code caps it at 50. |
| `runIdleTimeoutMinutes` | off | Idle-kill minutes when OMP produces no output for a long time; `0` or unset turns it off. |
| `requireMentionInGroup` | `true` | Whether group chats must `@bot` to get a response; DMs are unaffected. |
| `agentStopGraceMs` | `5000` | Milliseconds to wait for SIGKILL after the OMP process receives a stop signal; clamped to 100-30000. |

### Access control

User, chat and admin restrictions live under `preferences.access`:

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

Semantics:

- `allowedUsers` empty or unset: every user is allowed.
- `allowedChats` empty or unset: every chat is allowed.
- `admins` empty or unset: every allowed user may run admin commands.
- `owner` unset: falls back to `admins[0]`; when both are unset, high-risk commands are denied for everyone.
- Admin commands (`admins`): `/account`, `/config`, `/model`, `/thinking`, `/restart`, `/context`, `/resume`, `/session`, `/every`, `/search`, `/history`, `/sessions`, `/diff`, `/exit`, `/reconnect`, `/doctor`, `/cd`, `/ws`.
- Owner commands (`owner`, stricter than admins): `/release`, `/exec`, `/run` — only the owner can run them; a collaborator with admin still cannot execute shell.

## Data directory

| Path | Purpose |
| --- | --- |
| `~/.feishu-omp-bridge/config.json` | App credentials, secret refs, preferences. |
| `~/.feishu-omp-bridge/secrets.enc` | Local encrypted secret keystore. |
| `~/.feishu-omp-bridge/.keystore.salt` | Keystore salt. |
| `~/.feishu-omp-bridge/secrets-getter` | exec secret provider wrapper. |
| `~/.feishu-omp-bridge/sessions.json` | v3: `{ v, scopes, titles }` — each scope records only its **current session** (`sessionId`/`cwd`/`createdAt`/`updatedAt` plus the `/timeout` override), and session names live in `titles` keyed by **session id**. Old files migrate in place on load (v1/v2 each keep a `sessions.json.v<N>.bak`); the v2 “work session + segments” shape collapses to “current segment = current session”. |
| `~/.feishu-omp-bridge/omp-sessions/` | Bridge-only OMP JSONL session files. |
| `~/.feishu-omp-bridge/workspaces.json` | Named workspaces. |
| `~/.feishu-omp-bridge/processes.json` | Registry of bridge processes on this machine. |
| `~/.feishu-omp-bridge/media/` | Downloaded image / file cache. |
| `~/.feishu-omp-bridge/logs/` | Structured logs plus daemon stdout/stderr logs. |

## Feishu chat commands

| Command | Purpose |
| --- | --- |
| `/new`, `/reset` | Start a **new conversation** (the old one stays in `/history`). |
| `/new chat [name]` | Create a new group and pull you into it, inheriting the current cwd. Requires the `im:chat` permission for the bot. |
| `/cd <path>` | Change the working directory of the current chat/topic and start a new conversation (a mismatched cwd cannot resume the old session). Accepts absolute paths, `~/xxx`, and paths relative to the current directory (`src`, `../x`). |
| `/ws list` | List named workspaces. |
| `/ws add <name> <path>` | Save the current cwd as a named workspace. |
| `/ws use <name>` | Switch to a named workspace (changing the directory = a new conversation; same for `/ws undo`). |
| `/config` | Open the preferences card. |
| `/account` | Replace the bot app credentials and reconnect. |
| `/context` | Show the current session context (session id / title / cwd / model / idle timeout …). |
| `/rename <title>` | Name the current **conversation**; `/rename auto` generates it with an LLM (≤20 chars), `/rename clear` clears it. The title shows up in `/context`, `/status`, `/resume`, `/search`. |
| `/history [all]`, `/sessions` | Session list, newest activity first: by default only the **current working directory**, `all` for every working directory. One row = one OMP session (activity time / turn count / title or last user message); “Continue chat” restores it; paginates beyond 8 rows. Admin command. |
| `/status` | Show the current scope, cwd, session and agent. |
| `/stop` | Abort the OMP run currently executing. |
| `/timeout [N|off|default]` | Set the current session's idle timeout, or turn it off / fall back to the global default. |
| `/ps` | List every bridge process on this machine and mark the one replying now. |
| `/release` | Self-release: `pnpm typecheck` → `pnpm test` → `pnpm build`, then restart the daemon to load the new code. Any failure aborts without restarting. |
| `/exec <command>`, `/run` | Run a shell command in the current cwd and return its exit code + output (30 s timeout, output truncated to 1000 chars). Admin command. |
| `/exit <id|#>` | Shut down the given bridge process. |
| `/reconnect` | Force a WebSocket reconnect. |
| `/doctor [description]` | Hand the recent logs plus your failure description to OMP for self-diagnosis. |
| `/help` | Show the help card. |

Plain messages go straight to OMP. Group chats require `@bot` by default; DMs do not.

## Feishu card callbacks

The bridge recognizes two kinds of card callbacks:

1. Its own command cards, e.g. `/config`, `/help`, OMP UI cards.
2. Callback payloads generated by the agent. For compatibility with the older bridging layer the internal marker string `__codex_cb` is still used, although the code variables have been renamed to generic agent-callback naming.

Agent callbacks are turned into a follow-up message in the current scope, so OMP receives the user's click within the same session.

## OMP host tools in detail

### `feishu_current_context`

Arguments: none.

Example response:

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

Arguments:

```json
{
  "content": "Markdown content",
  "chatId": "optional, defaults to the current chat"
}
```

Behavior: sends Markdown to the target chat. If the target is the chat of the current topic, thread-reply options are included.

### `feishu_reply_message`

Arguments:

```json
{
  "content": "Markdown reply content",
  "messageId": "optional, defaults to the message that triggered this turn"
}
```

Behavior: replies to the given message; inside a topic it keeps the thread reply when possible.

### `feishu_get_message`

Arguments:

```json
{
  "messageId": "om_xxx"
}
```

Behavior: reads and normalizes the given Feishu message, suitable for letting OMP inspect a quoted message, a card's origin or forwarded content.

## `feishu://` URIs

OMP can read:

```text
feishu://current/context
feishu://message/<message_id>
```

The scheme is read-only today. Write operations return an error, so the agent cannot bypass the bridge's message-sending tools and permission boundary.

## Security notes

- Never commit `~/.feishu-omp-bridge/config.json`, `secrets.enc`, logs or session files.
- The App Secret is moved into the local encrypted keystore by default; `config.json` only stores a SecretRef.
- The local keystore protects against plaintext exposure through backups, accidental commits and log leakage; it is not a strong isolation key store against other processes of the same user.
- OMP can run local tools, which is equivalent to authorizing a local agent to act on Feishu messages. For production, configure:
  - `preferences.access.allowedUsers`
  - `preferences.access.allowedChats`
  - `preferences.access.admins`
  - the `ompTools` allowlist
  - fixed working directories / named workspaces
- Group chats require `@bot` by default, which avoids accidental triggers.
- `@all` never triggers a response.

## Development

Architecture and code-organization conventions: [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

### Self-update / self-heal

These scripts live in `scripts/` (shipped with the repo) and guard against the classic “the bot
updated itself over the weekend and never came back” failure:

- **`scripts/self-update.py`** — controlled self-update: `git pull` → `typecheck` → `test` → `build`,
  and only `restart`s when everything passes; any failing step rolls back to the previous HEAD and
  restores the backed-up `dist/`, leaving the daemon running the old version. An atomic lock prevents
  concurrent runs.
- **`scripts/self-heal.py`** — self-healing watchdog (a persistent launchd job,
  `ai.feishu-omp-bridge.heal`): every 60 s it probes “process alive + service running in the
  background”. Liveness is an OR of three independent signals (the pid launchd reports / the pid the
  process wrote into `processes.json` / `pgrep -f`), and only when all three say dead is it dead; a
  probe timeout or contradictory signals counts as “undecidable” and neither counts as an anomaly nor
  triggers action. After 3 consecutive **confirmed** anomalies it re-checks once, and only then
  `restart`s; if that still fails it spawns an omp session with log context to diagnose and fix
  (concurrency lock + stepped backoff + a 10-attempt cap + an exit contract in the prompt).
  - Install: `scripts/self-heal.py install`; uninstall: `uninstall`
  - One manual round: `scripts/self-heal.py --once`

Both self-update and self-heal have pytest coverage (isolated environments, production untouched):
  - `scripts/test_self_heal.py` — 27 scenarios: no false alarm when healthy / heal when the process is
    dead / heal on disconnect / no action on a pgrep false negative / no action when a probe times out
    / a status timeout is not health / re-check before acting / treat an unavailable omp as an anomaly
    / spawn omp when restart fails / lock mutual exclusion / backoff / omp concurrency lock / the fix
    loop / the attempt cap / the prompt contract / rollback (including restoring the original HEAD
    after a build timeout) / lock release on SIGKILL
  - `scripts/test_self_update.py` — 6 scenarios: successful update / rollback when typecheck / test /
    build / restart fails / lock mutual exclusion
  Run with `pnpm test:self-heal` (or `python3 -m pytest scripts/test_self_heal.py scripts/test_self_update.py`).
  pytest is required: `python3 -m pip install --user pytest`.

In addition, the plist generated by `src/daemon/launchd.ts` carries `ThrottleInterval=10` (guarding
against restart storms after a crash), and `start`/`restart` exit non-zero when they cannot reach
Feishu within 30 s (which makes launchd retry); with `SELF_HEAL=1` they also spawn omp to fix things.

Install dependencies:

```bash
pnpm install
```

Development watch:

```bash
pnpm dev
```

Type check:

```bash
pnpm typecheck
```

Tests:

```bash
pnpm test
```

Build:

```bash
pnpm build
```

Inspect the CLI:

```bash
node bin/feishu-omp-bridge.mjs --help
```

## Verification status

The current code-level verification covers:

- OMP RPC adapter arguments, event translation, session/run lifecycle.
- OMP native UI request/response.
- OMP host tool / host URI callbacks.
- UI responses of active runs and mid-run prompt routing.
- Config schema.
- The run-state reducer and Feishu-card related logic.

Regular verification commands:

```bash
pnpm typecheck
pnpm test
pnpm build
```

Real Feishu end-to-end verification needs working PersonalAgent credentials and an actual Feishu conversation environment.

## Troubleshooting

| Problem | Fix |
| --- | --- |
| Startup reports `omp` not found | Make sure `omp --version` works and run `omp` once to finish model / auth configuration. |
| No response after OMP RPC starts | Run `omp --mode rpc` alone as a smoke test; check `~/.feishu-omp-bridge/logs/`. |
| OMP did not continue the previous conversation | Send `/context` and look at the current session id: a deleted session file, or your own `/cd`, `/ws use`, `/new`, all switch to a new conversation (the old one is still in `/history` — click “Continue chat” to go back). The window's cwd no longer affects resumption: the bridge resumes the session's own directory. |
| A group chat gets no response | Make sure the message `@bot`s the bot, or adjust `requireMentionInGroup` in `/config` / `config.json`. |
| A card sits there for a long time | Interrupt with `/stop`; you can also enable idle probing for the current session with `/timeout 10`. |
| OMP is waiting for a choice / input | Reply to the standalone “OMP interaction” card; the idle watchdog is paused while waiting. |
| Feishu API tools are unavailable | Install and bind `lark-cli` as the startup prompt suggests, or prefer the registered Feishu host tools. |
| `/new chat` fails | Make sure the bot has the group-creation permissions; in code that capability depends on `im:chat`. |
| The background daemon does not work | Run `node bin/feishu-omp-bridge.mjs status` to inspect the service state and log paths. |
| **`cmux ping` reports “access denied”** | cmux defaults to `socketControlMode=cmuxOnly`, which only allows processes **started inside cmux**; switch it to **`Automation`** (Settings → Automation). See [`docs/CMUX-AGENT-INTERACTION.md`](docs/CMUX-AGENT-INTERACTION.md) §1. |
| **Sending a message to pi inside cmux does nothing** | When the target is busy the message enters the `Steering:` queue (consumed after the current turn ends); that is not a failure. Verify in pi's session JSONL. Same doc §5. |
| **`cmux send-key` times out / does nothing** | With the screen locked, `send-key` is unreliable (incomplete key-name support + intermittent timeouts); **always use `cmux send`** (use `'\r'` for Enter). Same doc §3. |
| **Delivering a multi-line message to a kimi panel re-runs the command** | `cmux paste-buffer` leaves the last 1–2 lines **in the input box**, which get **delivered again** at the end of the turn. After delivery you must: `send-key <ws> Up` (retrieve the leftover) → `send-key <ws> backspace` ×N → `read-screen` to confirm the input box is empty. Same doc §11.5. |
| **Thinking an agent inside cmux “is not doing anything”** | The cmux panel title comes from the **session's original title** and does not track the current action; judge activity from the session files on disk (kimi: mtime of `state.json` + `agents/main/wire.jsonl`). Same doc §12.3 / §12.7-1. |
| **`cmux send-key` with `C-u` reports `Unknown key`** | Combinations must be written `control-u` / `ctrl-u` (the `C-`/`M-` abbreviations are rejected); for the key list and side effects (`shift-tab` appears to toggle kimi's Plan mode) see the same doc §11.3 / §11.4. |
| **Want to see every cmux window's state at once** | Read `~/Library/Application Support/cmux/session-com.cmuxterm.app.json` (it holds each panel's latest notification, agent-completion notifications included) — faster than `read-screen` per panel and unaffected by the lock screen. Same doc §11.6. |
| **A panel never shows an agent notification** (e.g. `Cursor is waiting for you`) | Notifications come from cmux's agent hook (`~/.orca/agent-hooks/<agent>-hook.sh` → POST `127.0.0.1:$ORCA_AGENT_HOOK_PORT`): **only agents started inside a cmux panel get the `ORCA_*` environment variables**; ones started externally (launchd/bridge) will not notify. Also check that the hook file is executable and the agent config has a hook entry (`~/.cursor/hooks.json`, `~/.kimi-code/config.toml`). Same doc §14. |
| **Driving the Cursor agent** | Prefer the **non-interactive channel**: `cursor-agent -p "<prompt>" --output-format json` (`-p` grants write/shell permissions by default, so for unattended runs configure `--mode plan` or `--sandbox enabled`); sessions live in `~/.cursor/chats/<hash>/<chatId>/store.db` (SQLite; judge liveness by mtime/size). Same doc §13. |

## Related docs

| Document | Content |
| --- | --- |
| [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) | This repo's architecture, data flow, directory structure, command-organization conventions |
| [`docs/CMUX-AGENT-INTERACTION.md`](docs/CMUX-AGENT-INTERACTION.md) | **A field manual for driving cmux / pi / kimi / Cursor from the bridge**: enabling cmux permissions (`socketControlMode`), the lock-screen capability matrix and its pitfalls, `send` vs `send-key`, pi/omp differences, message-delivery semantics (idle = direct, busy = queued), and how to verify sessions without reading the screen; **§11 cmux CLI in general** (workspace/panel targeting, key names and their side effects, cleaning up the queued line left by `paste-buffer`); **§12 kimi (Kimi Code)**; **§13 Cursor (cursor-agent)** (multiple CLI versions, the SQLite session DB, the `-p` channel); **§14 the agent notification mechanism** (`~/.orca/agent-hooks` ⇄ cmux notifications) |

## Current limitations

- The Feishu host URI supports only `current/context` and `message/<message_id>`.
- `feishu://` is read-only; to send messages use `feishu_send_message` or `feishu_reply_message`.
- Real Feishu end-to-end capability depends on PersonalAgent permissions, tenant policies and the network environment.
- Deep OMP SDK integration is not enabled yet; the main path is the more stable, easier-to-debug, better process-isolated `omp --mode rpc`.

## License

MIT
