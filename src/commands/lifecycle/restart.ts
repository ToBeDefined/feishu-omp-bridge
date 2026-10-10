import type { CommandContext, Handler } from '../index';
import { RESTART_FLUSH_GRACE_MS, reply } from '../shared';
import { log } from '../../core/logger';
import { clearOnlineNotice, markOnlineNotice } from '../../bot/online-notify';
import { restartCard } from '../../card/templates';
import { sendManagedCard, updateManagedCard } from '../../card/managed';

export const restartHandlers: Record<string, Handler> = {
  '/restart': handleRestart,
};

async function handleRestart(_args: string, ctx: CommandContext): Promise<void> {
  log.info('command', 'restart', { scope: ctx.scope });
  let messageId: string | undefined;
  try {
    const sent = await sendManagedCard(
      ctx.channel,
      ctx.msg.chatId,
      restartCard('starting'),
      ctx.msg.messageId,
      { track: true, kind: 'restart' },
    );
    messageId = sent.messageId;
  } catch (err) {
    log.fail('command', err, { step: 'restart-card' });
    await reply(ctx, '🔄 正在重启…');
  }
  try {
    // The new process sends the boot confirmation for a real launchd restart.
    await markOnlineNotice(ctx.msg.chatId, 'notify', undefined, messageId);
    await new Promise((resolve) => setTimeout(resolve, RESTART_FLUSH_GRACE_MS));
    const realRestart = await ctx.controls.restartProcess();
    if (!realRestart) {
      await clearOnlineNotice();
      if (messageId) {
        await updateManagedCard(ctx.channel, messageId, restartCard('done')).catch(() => {});
      } else {
        await reply(ctx, '🚀 重启完成，已重新连接。');
      }
    }
    log.info('command', 'restart-ok', { realRestart });
  } catch (err) {
    log.fail('command', err, { step: 'restart' });
    await clearOnlineNotice();
    if (messageId) {
      await updateManagedCard(
        ctx.channel,
        messageId,
        restartCard('failed', err instanceof Error ? err.message : String(err)),
      ).catch(() => {});
    } else {
      await reply(ctx, '❌ 重启失败，bot 仍在线。');
    }
  }
}
