import type { CommandContext, Handler } from '../index';
import { log } from '../../core/logger';

export const stopHandlers: Record<string, Handler> = {
  '/stop': handleStop,
};

async function handleStop(_args: string, ctx: CommandContext): Promise<void> {
  const ok = ctx.activeRuns.interrupt(ctx.scope);
  log.info('command', 'stop', { interrupted: ok });
  // No reply: if there was a run, its in-flight render loop will mark the
  // card as 'interrupted' and re-render (`_⏹ 已被中断_`).
}
