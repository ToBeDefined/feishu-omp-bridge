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
│  model-history / reaction / quote / group / comments / …       │
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
| `session/` | OMP 会话存储 |
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
    new.ts            /new /reset
    cd.ts             /cd
    ws.ts             /ws (list/save/use/remove/undo/cancel)
    status.ts         /status
    timeout.ts        /timeout
    context.ts        /context + renderContext + 会话扫描
    resume.ts         /resume /session
    search.ts         /search + 搜索逻辑 + 结果卡片
    shared.ts         session 内部共享(summarize)
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
   - 目录内部共享 → 目录内 `shared.ts`（如 session/shared.ts 的 summarize）
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
- 纯逻辑（数据/格式化/解析）：优先可测，如 model-history / prompt / scheduler
- 涉及真实飞书 SDK 的链路：`*.integration.test.ts`，用 `RUN_INTEGRATION=1` 显式启用
- 命令 handler：mock CommandContext + store，测 dispatch / admin 门控 / 错误处理

## 单进程保障

- 同一飞书应用只允许一个 bridge 进程（launchd 管理）
- `run` 检测到已有实例直接拒绝（`rejectDuplicates`）
- `start`/`restart` 走 stop → `killStrayProcesses` → start（含按进程名兜底清理）
- 详见 `src/cli/commands/start.ts` 与 `service.ts`
