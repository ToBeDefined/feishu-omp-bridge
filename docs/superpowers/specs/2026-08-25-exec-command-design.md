# /exec 直接执行命令设计

日期：2026-08-25

## 背景

bridge 把飞书消息桥到本地 OMP，但没有「用户在飞书里直接跑一条 shell 命令、
看到输出」的能力。改代码、看状态、跑测试都要开电脑。补一个高权限 slash 命令，
人不在电脑前也能远程操作本机。

## 目标

新增 `/exec <命令>`：admin only，在当前 scope 的 cwd 下用 `/bin/sh -c` 执行任意
shell 命令（支持管道 / 重定向 / 变量），回退出码 + 合并后的输出。

## 方案

### 命令签名与门禁

- 命令名 `/exec`，参数即 shell 命令字符串。
- 加入 `ADMIN_COMMANDS`：非 admin 由 dispatch 层直接拒绝（现有机制）。

### 执行 `src/commands/lifecycle/exec.ts`

```ts
runCommand(cmd: string, cwd: string, timeoutMs: number): Promise<RunResult>
```

- `spawn('/bin/sh', ['-c', cmd], { cwd, stdio: ['ignore', 'pipe', 'pipe'], detached: true })`。
- `detached: true` 使子进程自成进程组；超时 `process.kill(-pid, 'SIGKILL')` 整组杀，
  防 `sh` fork 出的孙进程残留。
- stdin `ignore`（EOF）：交互式命令（`vim`/`top`）立即退出或等超时被杀。
- stdout + stderr 合并，尾部截断 1000 字符（前缀 `…（已截断）`）。
- 超时 30 秒。

返回：

```ts
interface RunResult {
  exitCode: number | null; // null = spawn 失败（如 cwd 不存在）
  output: string;
  timedOut: boolean;
}
```

### 回显与审计

- 成功 `✅ 退出码 0` / 失败 `❌ 退出码 N` / 超时 `⏱ 执行超时（30s），已终止`；
  输出放 code block（与 `/diff` 一致，接受输出含 ``` 的极小概率破坏）。
- 每次执行写审计：`log.info('command', 'exec', { scope, cwd, cmd, exitCode, timedOut })`。

### 注册

- `src/commands/lifecycle/index.ts` 挂 `execHandlers`。
- `src/commands/index.ts` `ADMIN_COMMANDS` 加 `'/exec': true`。

## 非目标

- 不做 CLI 版（终端本就能跑命令）。
- 不做交互式 stdin。
- 不做命令白名单（admin 即机器主人，风险自担，以审计日志留痕）。

## 测试

- `src/commands/lifecycle/exec.test.ts`：
  - `runCommand`（mock `node:child_process` 的 `spawn`）：成功、非零退出、
    spawn 失败、超时杀进程组、输出截断、cwd 透传。
  - handler（mock `runCommand`）：成功 / 失败 / 超时三种回显，空参数用法提示。

## 落点

- 新增 `src/commands/lifecycle/exec.ts`、`src/commands/lifecycle/exec.test.ts`
- 修改 `src/commands/lifecycle/index.ts`、`src/commands/index.ts`
- 修改 `README.md`、`README.zh.md`、`CHANGELOG.md`
