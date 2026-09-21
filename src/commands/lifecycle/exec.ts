import { spawn } from 'node:child_process';
import { homedir } from 'node:os';
import { codeFence } from '../../card/templates';
import type { CommandContext, Handler } from '../index';
import { reply } from '../shared';
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
      });
    });

    child.on('close', (code) => {
      const tailed =
        output.length > OUTPUT_TAIL
          ? `…（输出已截断，仅显示尾部）\n${output.slice(-OUTPUT_TAIL)}`
          : output;
      finish({ exitCode: code, output: tailed, timedOut });
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
  const cwd = ctx.workspaces.cwdFor(ctx.scope) ?? homedir();
  const result = await runCommand(cmd, cwd, EXEC_TIMEOUT_MS);
  log.info('command', 'exec', {
    scope: ctx.scope,
    cwd,
    cmd,
    exitCode: result.exitCode,
    timedOut: result.timedOut,
  });
  const body = result.output.trim() ? `\n${codeFence(result.output)}` : '';
  if (result.timedOut) {
    await reply(ctx, `⏱ 执行超时（${EXEC_TIMEOUT_MS / 1000}s），已终止。${body}`);
    return;
  }
  if (result.exitCode === null) {
    await reply(ctx, `❌ 无法执行${body}`);
    return;
  }
  if (result.exitCode === 0) {
    await reply(ctx, `✅ 退出码 0${body}`);
  } else {
    await reply(ctx, `❌ 退出码 ${result.exitCode}${body}`);
  }
}
