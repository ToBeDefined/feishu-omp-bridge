import { homedir } from 'node:os';
import type { CommandContext, Handler } from '../index';
import { getOmpModel } from '../../config/schema';
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

  await reply(ctx, '🫧 正在压缩会话上下文，完成后通知你…');
  const error = await ctx.agent.compactSession?.({
    sessionId,
    cwd,
    model: getOmpModel(ctx.controls.cfg),
    customInstructions,
  });
  if (error) {
    await reply(ctx, `❌ 压缩失败：${error}`);
  } else {
    await reply(ctx, '✅ 会话上下文已压缩，下条消息生效。');
  }
}
