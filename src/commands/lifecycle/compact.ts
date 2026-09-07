import { homedir } from 'node:os';
import type { CommandContext, Handler } from '../index';
import { getOmpModel, getOmpSessionDir } from '../../config/schema';
import { compactTimeoutMs, estimateCompactSeconds, estimateSessionTokens } from '../../agent/omp/estimate';
import { reply } from '../shared';

export const compactHandlers: Record<string, Handler> = {
  '/compact': handleCompact,
};

async function handleCompact(args: string, ctx: CommandContext): Promise<void> {
  const customInstructions = args.trim() || undefined;

  // Active run: queue the compact to fire when the run finishes. Compaction
  // in OMP aborts the in-flight turn, and the bridge reaps the child ~2s
  // after the turn's terminal event — a compact frame sent mid-run would be
  // killed before it finished. After the run, the session file is settled
  // and the oneshot compactor can do the whole job.
  if (ctx.activeRuns.has(ctx.scope)) {
    const queued = ctx.activeRuns.deferCompact(ctx.scope, () => {
      void compactIdle(ctx, customInstructions).catch((err) => {
        void reply(ctx, `❌ 压缩失败：${err instanceof Error ? err.message : String(err)}`);
      });
    });
    if (queued) {
      await reply(ctx, '🫧 当前任务结束后自动压缩会话上下文。');
      return;
    }
  }

  await compactIdle(ctx, customInstructions);
}

/**
 * Compact the persisted session with a short-lived OMP process. Re-resolves
 * the session id at call time: when queued mid-run, a /cd reset between the
 * request and the run finishing must not compact the cleared session.
 */
async function compactIdle(ctx: CommandContext, customInstructions?: string): Promise<void> {
  const cwd = ctx.workspaces.cwdFor(ctx.scope) ?? homedir();
  const sessionId = ctx.sessions.resumeFor(ctx.scope, cwd);
  if (!sessionId) {
    await reply(ctx, '⚠️ 当前没有可压缩的会话（先发起一次对话）。');
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
  const error = await ctx.agent.compactSession?.({
    sessionId,
    cwd,
    model: getOmpModel(ctx.controls.cfg),
    customInstructions,
    timeoutMs: compactTimeoutMs(tokens),
  });
  if (error) {
    await reply(ctx, `❌ 压缩失败：${error}`);
  } else {
    await reply(ctx, '✅ 会话上下文已压缩，下条消息生效。');
  }
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
