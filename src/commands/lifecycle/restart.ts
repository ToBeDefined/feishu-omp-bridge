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
    `🔄 正在重启当前 bot \`${ctx.controls.processId}\`…\n\n_采用进程内重连（先建新连接再断旧的），即使重连失败也会保留当前连接，不会掉线。约几秒完成。_`,
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
      await reply(ctx, '✅ 重启完成，已重新连接。');
    } else {
      await reply(ctx, '❌ 重启失败，但原连接已保留，bot 仍在线。');
    }
  } catch (err) {
    log.fail('command', err, { step: 'restart-reply' });
  }
}
