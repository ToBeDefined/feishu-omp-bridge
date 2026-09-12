import { homedir } from 'node:os';
import type { AgentRun } from '../../agent/types';
import type { CommandContext, Handler } from '../index';
import { getOmpModel, getOmpSessionDir } from '../../config/schema';
import { compactTimeoutMs, estimateCompactSeconds, estimateSessionTokens } from '../../agent/omp/estimate';
import { reply } from '../shared';

export const compactHandlers: Record<string, Handler> = {
  '/compact': handleCompact,
};

async function handleCompact(args: string, ctx: CommandContext): Promise<void> {
  const customInstructions = args.trim() || undefined;

  // Active run (or an in-flight oneshot compact): queue until it unregisters.
  // Compaction in OMP aborts the in-flight turn, and the bridge reaps the
  // child ~2s after the turn's terminal event — a compact frame sent mid-run
  // would be killed before it finished. After the run, the session file is
  // settled and the oneshot compactor can do the whole job.
  if (queueIfBusy(ctx, customInstructions)) {
    await reply(ctx, '🫧 当前任务结束后自动压缩会话上下文。');
    return;
  }

  await compactIdle(ctx, customInstructions);
}

/**
 * Compact the persisted session with a short-lived OMP process. Re-resolves
 * the session id at call time: when queued mid-run, a /cd reset between the
 * request and the run finishing must not compact the cleared session.
 */
async function compactIdle(
  ctx: CommandContext,
  customInstructions?: string,
  opts: { silentIfMissing?: boolean } = {},
): Promise<void> {
  if (queueIfBusy(ctx, customInstructions)) return;

  const abort = new AbortController();
  const occupy = occupyCompact(ctx, abort);
  if (!occupy) {
    // A run landed between the has() check and register. Queue rather than
    // overwrite its handle (that would break /stop and steal the session).
    if (queueIfBusy(ctx, customInstructions)) return;
    return;
  }

  try {
    const cwd = ctx.workspaces.cwdFor(ctx.scope) ?? homedir();
    const sessionId = ctx.sessions.resumeFor(ctx.scope, cwd);
    if (!sessionId) {
      if (!opts.silentIfMissing) {
        await reply(ctx, '⚠️ 当前没有可压缩的会话（先发起一次对话）。');
      }
      return;
    }

    if (!ctx.agent.compactSession) {
      await reply(ctx, '❌ 当前 adapter 不支持压缩会话');
      return;
    }

    // Size the run before starting it: compaction time tracks the session's
    // real context occupancy (≈1.35 s per 1k tokens, measured), not its byte
    // size. A 10 MB / 690k-token session needs tens of minutes; the old fixed
    // 600 s cap SIGKILLed it mid-flight every time.
    const estimate = await estimateSessionTokens(getOmpSessionDir(ctx.controls.cfg), sessionId);
    const tokens = estimate?.tokens ?? 0;
    const etaSeconds = Math.round(estimateCompactSeconds(tokens));
    const sizeLine = estimate
      ? `📏 会话 ≈${(tokens / 1000).toFixed(0)}k token / ${(estimate.bytes / 1024 / 1024).toFixed(1)} MB，预计 ≈${fmtDuration(etaSeconds)}（上限 ${fmtDuration(compactTimeoutMs(tokens) / 1000)}）`
      : '';
    await reply(ctx, `🫧 正在压缩会话上下文，完成后通知你…${sizeLine ? `\n${sizeLine}` : ''}`);
    const error = await ctx.agent.compactSession({
      sessionId,
      cwd,
      model: getOmpModel(ctx.controls.cfg),
      customInstructions,
      timeoutMs: compactTimeoutMs(tokens),
      signal: abort.signal,
    });
    if (error) {
      await reply(ctx, `❌ 压缩失败：${error}`);
    } else {
      await reply(ctx, '✅ 会话上下文已压缩，下条消息生效。');
    }
  } finally {
    ctx.activeRuns.unregister(ctx.scope, occupy);
  }
}

/** Queue a compact onto the live handle. Returns false when the slot is free. */
function queueIfBusy(ctx: CommandContext, customInstructions?: string): boolean {
  if (!ctx.activeRuns.has(ctx.scope)) return false;
  return ctx.activeRuns.deferCompact(ctx.scope, () => {
    void compactIdle(ctx, customInstructions, { silentIfMissing: true }).catch((err) => {
      void reply(ctx, `❌ 压缩失败：${err instanceof Error ? err.message : String(err)}`);
    });
  });
}

/**
 * Hold the scope's run slot for the oneshot compact so has() / the scheduler
 * / the pending flush all see the session as busy. stop() aborts the child
 * (/stop, idle watchdog, stopAll).
 */
function occupyCompact(ctx: CommandContext, abort: AbortController): AgentRun | undefined {
  if (ctx.activeRuns.has(ctx.scope)) return undefined;
  const run: AgentRun = {
    events: (async function* () {})(),
    async stop() {
      abort.abort();
    },
    waitForExit: async () => true,
  };
  ctx.activeRuns.register(ctx.scope, run);
  return run;
}

/** Seconds → "Xh Ym" / "Ym Zs" / "Zs". */
function fmtDuration(seconds: number): string {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.round(seconds % 60);
  if (h > 0) return `${h}小时${m}分`;
  if (m > 0) return `${m}分${s}秒`;
  return `${s}秒`;
}
