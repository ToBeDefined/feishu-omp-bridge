import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { execResultCard } from '../../card/templates';
import type { CommandContext, Handler } from '../index';
import { reply } from '../shared';
import { conversationCwd } from '../../session/current-cwd';
import { log } from '../../core/logger';

export const EXEC_TIMEOUT_MS = 30_000;
const OUTPUT_TAIL = 1000;
/**
 * Cap on the live output buffer. Only the tail is ever displayed, so a chatty
 * command (`yes`, `cat /dev/urandom`, `find /`) must not be able to grow the
 * daemon's heap for the whole timeout — that would OOM the bot for every chat.
 */
const OUTPUT_BUFFER_MAX = 64 * 1024;

function appendTail(current: string, chunk: Buffer): string {
  const next = current + chunk.toString();
  return next.length > OUTPUT_BUFFER_MAX ? next.slice(-OUTPUT_BUFFER_MAX) : next;
}

export interface RunResult {
  /** Process exit code, or null when the spawn itself failed (e.g. bad cwd). */
  exitCode: number | null;
  /** Merged stdout+stderr, tail-truncated. */
  output: string;
  timedOut: boolean;
  /** Why there is no exit code — spawn failure or a signal kill. The caller may
   * override it when it can name a better root cause (e.g. a dead cwd). */
  reason?: string;
}

/**
 * Run a shell command via `bash -c`. stdin is EOF (no interaction);
 * stdout/stderr are merged and tail-truncated. On timeout the whole process
 * group is SIGKILLed so grandchildren don't leak.
 */
export function runCommand(cmd: string, cwd: string, timeoutMs: number): Promise<RunResult> {
  return new Promise((resolve) => {
    const child = spawn('bash', ['-c', cmd], {
      cwd,
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: true,
    });

    let output = '';
    let timedOut = false;
    let settled = false;
    let timer: NodeJS.Timeout;

    child.stdout!.on('data', (chunk: Buffer) => {
      output = appendTail(output, chunk);
    });
    child.stderr!.on('data', (chunk: Buffer) => {
      output = appendTail(output, chunk);
    });

    const finish = (result: RunResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };

    timer = setTimeout(() => {
      timedOut = true;
      try {
        process.kill(-child.pid!, 'SIGKILL');
      } catch {
        child.kill('SIGKILL');
      }
    }, timeoutMs);

    child.on('error', (err) => {
      finish({
        exitCode: null,
        output: `${output}\n(无法执行: ${err.message})`.trim(),
        timedOut: false,
        reason: 'shell 进程启动失败',
      });
    });

    child.on('close', (code) => {
      const tailed =
        output.length > OUTPUT_TAIL
          ? `…（输出已截断，仅显示尾部）\n${output.slice(-OUTPUT_TAIL)}`
          : output;
      // 超时那一路自己会说明原因；其余的 code === null 是被外部信号打断。
      const reason = code === null && !timedOut ? '进程被信号终止，退出码未知' : undefined;
      finish({ exitCode: code, output: tailed, timedOut, ...(reason ? { reason } : {}) });
    });
  });
}

export const execHandlers: Record<string, Handler> = {
  '/exec': handleExec,
  '/run': handleExec,
};
async function handleExec(args: string, ctx: CommandContext): Promise<void> {
  const cmd = args.trim();
  if (!cmd) {
    await reply(ctx, '用法：`/exec <shell 命令>`');
    return;
  }
  // 会话优先：在**当前会话**的目录里执行。
  const cwd = conversationCwd(ctx.workspaces, ctx.sessions, ctx.scope);
  const result = await runCommand(cmd, cwd, EXEC_TIMEOUT_MS);
  log.info('command', 'exec', {
    scope: ctx.scope,
    cwd,
    cmd,
    exitCode: result.exitCode,
    timedOut: result.timedOut,
  });
  const body = result.output.trim();
  const reason = failureReason(result, cwd);
  await ctx.channel.send(
    ctx.msg.chatId,
    {
      card: execResultCard({
        cmd,
        cwd,
        exitCode: result.exitCode,
        output: body,
        timedOut: result.timedOut,
        timeoutSeconds: EXEC_TIMEOUT_MS / 1000,
        ...(reason !== undefined ? { reason } : {}),
      }),
    },
    { replyTo: ctx.msg.messageId },
  );
}

/** spawn 失败时 Node 只报 `spawn bash ENOENT`，看不出是 shell 还是目录的问题；
 *  目录已经不在（被删 / 被 /cd 到一个已移除的工作空间）是最常见的真因，优先报它。 */
function failureReason(result: RunResult, cwd: string): string | undefined {
  if (result.exitCode !== null || result.timedOut) return undefined;
  return existsSync(cwd) ? result.reason : '执行目录不存在';
}
