# /release 自发布命令设计

日期：2026-08-25

## 背景

bridge 的部署链路是：改 `src/` → `pnpm build`（产出 `dist/`）→
`/restart`（launchd `kickstart -k` 重启加载新 `dist/`）。`/restart` 只重启
进程、不重新构建，`pnpm build` 只能手敲，三步里 build 最容易漏——漏掉后
重启加载的仍是旧产物，表现为"改了代码但行为没变"。

## 目标

新增 `/release` 命令（飞书侧）+ `feishu-omp-bridge release`（CLI 侧），
一条命令完成 typecheck → test → build → restart，失败时不动运行中的进程。

## 方案

共用一个构建核心，飞书命令与 CLI 命令各自薄封装。不引入 `git pull` /
`pnpm install`（远端依赖与本地未提交改动的冲突风险超出本次范围）。

### 共享核心 `src/release/run.ts`

```ts
runRelease(exec?): Promise<ReleaseResult>
```

步骤序列（任一非零即中止，不再执行后续步骤）：

| 步骤 | 命令 | 超时 |
| --- | --- | --- |
| typecheck | `pnpm typecheck`（`tsc --noEmit`） | 60s |
| test | `pnpm test`（`vitest run`） | 120s |
| build | `pnpm build`（`tsup`） | 120s |

返回：

```ts
interface ReleaseResult {
  ok: boolean;
  step?: string;       // 失败步骤名
  exitCode?: number;   // 非零退出码
  output?: string;     // 失败输出尾部（截断 2000 字符）
  timedOut?: boolean;  // 超时
  pnpmMissing?: boolean; // pnpm 不可解析（ENOENT）
}
```

- 执行用 `node:child_process` 的 `execFile`，命令 `pnpm`（launchd plist 已
  配置含 nvm node bin 的 `PATH`；CLI 环境在用户终端 PATH 内）。
- 错误分类：`ENOENT` → `pnpmMissing`；`killed` → `timedOut`；否则取退出码
  与输出尾部。
- `exec` 参数可注入，供单测替换。

### 飞书 `/release` handler（`src/commands/lifecycle/release.ts`）

- admin 命令（加入 `ADMIN_COMMANDS`）。
- 进程级 `inFlight` 标志防重入。
- 流程：先回「开始发布」→ `runRelease()`：
  - 失败 → 回「❌ 发布失败于 <step>：<详情>」，不 restart。
  - 成功 → 回「✅ 构建成功，正在重启…」→ `ctx.controls.restartProcess()`
    （复用 `/restart` 的 kickstart 路径：launchd 下进程被杀、拉起新 dist；
    非 launchd 回退进程内重连）。
- kickstart 自杀式重启会中断当前 run，与 `/restart` 语义一致；session 持久
  化在 `~/.feishu-omp-bridge/omp-sessions/`，重启后 `--resume` 续聊。

### CLI `release`（`src/cli/commands/release.ts`）

- `runRelease()` 成功后复用 `runServiceRestart()`（现有 CLI restart：重装
  service 文件 + kickstart + 等重连 + 打印状态）。
- 失败 → stderr 输出 + `process.exit(1)`。

## 非目标

- 不做 `git pull` / `pnpm install`。
- 不改 `/restart` 语义（保持轻量、只重启）。
- 不做构建产物回滚（已有 self-heal 的回退路径）。

## 测试

- `src/release/run.test.ts`：注入 fake `exec`，覆盖成功路径、每步失败中止、
  步骤顺序、`pnpmMissing`、`timedOut`、输出截断。
- `src/commands/lifecycle/release.test.ts`：mock `runRelease` 与
  `ctx.controls.restartProcess`，覆盖成功重启、失败不重启、重入拦截。

## 落点

- 新增 `src/release/run.ts`、`src/release/run.test.ts`
- 新增 `src/commands/lifecycle/release.ts`、`src/commands/lifecycle/release.test.ts`
- 新增 `src/cli/commands/release.ts`
- 修改 `src/commands/lifecycle/index.ts`（注册 handler）
- 修改 `src/commands/index.ts`（`ADMIN_COMMANDS` 加 `/release`）
- 修改 `src/cli/index.ts`（注册 CLI 命令）
- 修改 `README.md`、`README.zh.md`、`CHANGELOG.md`
