import type { CommandContext, Handler } from '../index';
import { reply } from '../shared';

export const compactHandlers: Record<string, Handler> = {
  '/compact': handleCompact,
};

async function handleCompact(args: string, ctx: CommandContext): Promise<void> {
  const customInstructions = args.trim() || undefined;
  const ok = ctx.activeRuns.compact(ctx.scope, customInstructions);
  if (ok) {
    await reply(ctx, '✅ 已请求压缩当前会话上下文。');
  } else {
    await reply(ctx, '⚠️ 当前没有正在运行的 OMP 任务，无法压缩。');
  }
}
