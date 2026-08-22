import type { CommandContext, Handler } from '../index';
import { reply } from '../shared';
import { log } from '../../core/logger';

export const restartHandlers: Record<string, Handler> = {
  '/restart': handleRestart,
};

async function handleRestart(_args: string, ctx: CommandContext): Promise<void> {
  log.info('command', 'restart', { scope: ctx.scope });
  await reply(
    ctx,
    `🔄 正在重启…`,
  );
  let restarted = false;
  try {
    await ctx.controls.restart();
    restarted = true;
    log.info('command', 'restart-ok');
  } catch (err) {
    log.fail('command', err, { step: 'restart' });
  }
  try {
    if (restarted) {
      await reply(ctx, '🚀 重启完成，已重新连接。');
    } else {
      await reply(ctx, '❌ 重启失败，bot 仍在线。');
    }
  } catch (err) {
    log.fail('command', err, { step: 'restart-reply' });
  }
}
