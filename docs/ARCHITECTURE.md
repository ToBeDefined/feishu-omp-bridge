# feishu-omp-bridge 架构

本文档描述项目整体架构，以及后续开发时的代码组织约定。

## 总体架构

```
┌─────────────────────────────────────────────────────────────┐
│                       CLI 入口 (src/cli)                      │
│  index.ts       命令注册(run/start/restart/stop/ps/secrets…)  │
│  commands/      service(launchd 管理) / start(进程内启动)      │
└────────────────────────────┬────────────────────────────────┘
                             │ startChannel()
┌────────────────────────────▼────────────────────────────────┐
│                    bot 编排层 (src/bot)                        │
│  channel.ts     WS 装配: 连接/事件挂载/pending队列/keepalive    │
│  intake.ts      消息入站: 权限→表情确认→命令路由→入队            │
│  batch.ts       run 编排: 媒体/引用/prompt→agent→流式渲染        │
│  prompt.ts      提示词构建(纯函数)                              │
│  feishu-host.ts agent 可用的飞书工具(feishu_* host tools)       │
│  reaction / quote / comments / model-history / …              │
└───────┬──────────────┬──────────────────┬─────────────────────┘
        │              │                  │
┌───────▼──────┐ ┌─────▼──────┐  ┌───────▼───────┐
│ commands/    │ │ card/      │  │ scheduler/    │
│ 命令处理      │ │ 卡片渲染    │  │ 定时任务       │
└───────┬──────┘ └─────┬──────┘  └───────┬───────┘
        │              │                  │
┌───────▼──────────────▼──────────────────▼───────┐
│    领域层 (config / session / workspace /        │
│    media / runtime / daemon / agent / core)      │
└─────────────────────────────────────────────────┘
```

## 数据流

### 消息处理链路
```
飞书消息 → channel.on('message') → intakeMessage
  → 权限校验(allowedUsers / allowedChats / @bot 策略)
  → addReaction(收到表情)
  → tryHandleCommand(斜杠命令) 或 pending 队列入队(600ms debounce)
  → runAgentBatch(spawn omp --mode rpc)
  → channel.stream(流式卡片回写飞书)
```

### 命令分发链路
```
飞书斜杠命令或卡片按钮
  → dispatcher(卡片 action) / tryHandleCommand(文本)
  → commands/index.ts 注册表 → 对应命令文件 handler
  → handler 通过 ctx(CommandContext) 访问 store / agent / channel
```

### Agent 工具调用链路
```
OMP agent 调 feishu_* host tool
  → bot/feishu-host.ts 的 execute()
  → 直接操作 channel(SDK) 或 store
  → 返回结构化结果给 agent
```

## 持久化与会话

单文件单真相：`~/.feishu-omp-bridge/sessions.json` 是会话状态的唯一持久层，原子写（临时文件 + `rename`）。**持久化单位是 OMP 会话本身 —— 一个 OMP 会话 = 一个对话**，不是 chat，也不是「一次工作」。

`sessions.json` v3 形状：

```jsonc
{
  "v": 3,
  "scopes": {                     // 每个 chat / chat:thread / 话题 / 文档评论一条
    "oc_x": {
      "sessionId": "<OMP session id>",  // 缺失 = 下一条消息开新对话
      "cwd": "/repo",                   // 与 sessionId 同进同出（/timeout 覆盖另存）
      "createdAt": 0, "updatedAt": 0,
      "idleTimeoutMinutes": 30          // /timeout 覆盖；0 = 关闭，缺失 = 跟随全局
    }
  },
  "titles": { "<OMP session id>": "bridge UI 调整" }   // /rename 命名会话
}
```

**scope → 当前会话**：`sessionFor(scope)` 给出这条会话的 `sessionId` + `cwd`；`startNew(scope)`（`/new`、`/cd`、`/ws use`）清掉指针，OMP 报告 `system.sessionId` 时 `bind(scope, sessionId, cwd)` 写回。旧对话不删——它本来就是 `omp-sessions/*.jsonl` 里的一个文件，只由 `/history` 扫描列出。

**名字跟着会话 id**：`/rename` 写 `titles[sessionId]`，因此 `/history`、`/search`、`/resume`、`/context` 换走再换回来都还是同一个名字；无名时回退该会话最后一条用户消息。

**v1 / v2 → v3 迁移**：加载遇旧格式就地迁移，迁前留一份 `sessions.json.v<N>.bak`（已存在不覆盖）。v1（每 chat 一条平铺 `{sessionId, cwd, …}`）直接成为一条 scope 记录；v2（`scopes[scope].activeWorkSession` + `workSessions[].segments`）收敛为「当前段 = 当前会话」，其余段本来就以会话文件出现在 `/history` 里，平铺名字回填进 `titles`。

## 目录结构 (src/)

| 目录 | 职责 |
|---|---|
| `cli/` | CLI 命令入口 + launchd/systemd service 管理 |
| `bot/` | 编排层：channel(装配) / intake(入站) / batch(run) / prompt / host tools |
| `card/` | 飞书卡片：渲染 / 状态机 / dispatcher / managed 卡片托管 |
| `commands/` | 命令处理（见下节） |
| `scheduler/` | 定时任务调度器（纯逻辑 + 持久化，`/every` 使用） |
| `agent/` | OMP RPC 适配器（`AgentAdapter` 接口 + OMP 实现） |
| `config/` | 配置 schema / 存储 / 密钥解析 |
| `session/` | 会话存储（`SessionStore` v3 + v1/v2 迁移）、`current-cwd` 目录解析、模型历史 |
| `workspace/` | 工作区（cwd / 命名空间 / undo） |
| `media/` | 附件下载缓存 |
| `runtime/` | 进程注册表（/ps /exit 依据） |
| `daemon/` | launchd / systemd / schtasks 适配 |
| `core/` | 日志 |
| `utils/` | 通用工具（如飞书凭据校验） |

## 命令组织约定

**核心原则：一个命令一个文件；命令目录承载该域全部命令。**

### 结构示例

```
src/commands/
  index.ts            注册表 + dispatch + Controls/CommandContext 类型
  shared.ts           跨命令公共工具(reply/recall/formatAgo/FORM_SETTLE_MS/expandTilde)
  session/            会话/工作区类命令
    new.ts            /new /reset（清当前会话，下条消息重开）+ /new chat
    cd.ts             /cd（换目录 = 换会话）
    ws.ts             /ws (list/save/use/remove/undo/cancel)
    status.ts         /status
    timeout.ts        /timeout
    context.ts        /context /ctx + renderContext
    rename.ts         /rename [+ auto|clear]（名字按 session id 存）
    resume.ts         /resume /session（applyResume 由 /history 按钮复用）
    history.ts        /history /sessions（会话清单卡片 + 「继续对话」）
    sessions.ts       扫描 omp-sessions/*.jsonl（清单聚合）
    search.ts         /search + 搜索逻辑(渲染在 card/search-card.ts)
    diff.ts           /diff
    group.ts          新建群并绑定新会话
    index.ts          sessionHandlers 汇总
  model/
    model.ts          /model
    thinking.ts       /thinking /think
    data.ts           模型数据层(列表/常用/缓存)
    index.ts          modelHandlers 汇总
  lifecycle/
    stop.ts / restart.ts / reconnect.ts / ps.ts / exit.ts / help.ts / every.ts
    index.ts          lifecycleHandlers 汇总
  account/
    account.ts        /account
    config.ts         /config
    doctor.ts         /doctor
    index.ts          accountHandlers 汇总
```

### 规则

1. **一命令一文件**：文件导出 `xxxHandlers: Record<string, Handler>`，只含该命令 handler + 内部辅助函数
2. **目录 index.ts**：合并本目录所有 handler，导出统一命名（`sessionHandlers` 等）
3. **顶层 index.ts**：只做注册表合并 + dispatch，不含业务逻辑
4. **共享工具分层**：
   - 跨命令通用 → `commands/shared.ts`
   - 目录内部共享 → 目录内 `shared.ts`；纯工具(如 summarize)放 commands/shared.ts
5. **数据/纯逻辑分离**：命令里的数据层抽到同目录独立文件（如 model/data.ts），与 handler 解耦，便于单测
6. **避免**：
   - 单文件塞多个不相关命令
   - handler 里写大段数据逻辑（应抽到 data/ 文件）
   - 跨目录 import 对方的内部实现（只通过 index.ts 的公共导出）
7. **新增命令流程**：
   - 在对应目录新建 `<cmd>.ts`，实现 handler + 导出 handlers 表
   - 目录 `index.ts` 合并
   - 需 admin 门控 → 顶层 `index.ts` 的 `ADMIN_COMMANDS` 注册
   - 卡片按钮 `cmd: 'xxx.action'` → dispatcher 拆成 `xxx action` 路由到对应 handler

## 新增能力落点速查

| 能力类型 | 落点 |
|---|---|
| 新斜杠命令 | `commands/<域>/<cmd>.ts` |
| agent 可用工具(host tool) | `bot/feishu-host.ts`（注册进 `createFeishuHostIntegration`） |
| 定时任务 | `scheduler/` + `/every` 命令 |
| 卡片渲染 | `card/`（renderer + 各卡片文件） |
| 新消息事件 | `bot/channel.ts` 事件挂载 |

## 测试约定

- 单元测试：`*.test.ts` 与被测文件同目录
- 纯逻辑（数据/格式化/解析）：优先可测，如 model-history(session/) / prompt / scheduler
- 涉及真实飞书 SDK 的链路：`*.integration.test.ts`，用 `RUN_INTEGRATION=1` 显式启用
- 命令 handler：mock CommandContext + store，测 dispatch / admin 门控 / 错误处理

## 单进程保障

- 同一飞书应用只允许一个 bridge 进程（launchd 管理）
- `run` 检测到已有实例直接拒绝（`rejectDuplicates`）
- `start`/`restart` 走 stop → `killStrayProcesses` → start（含按进程名兜底清理）
- 详见 `src/cli/commands/start.ts` 与 `service.ts`
