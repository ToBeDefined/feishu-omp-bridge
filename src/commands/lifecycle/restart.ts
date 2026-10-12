import type { CommandContext, Handler } from '../index';
import { RESTART_FLUSH_GRACE_MS, parseForceArg, reply } from '../shared';
import { waitForRunsToDrain } from './release';
import { log } from '../../core/logger';
import { clearOnlineNotice, markOnlineNotice } from '../../bot/online-notify';
import { restartCard } from '../../card/templates';
import { sendManagedCard, updateManagedCard } from '../../card/managed';

export const restartHandlers: Record<string, Handler> = {
  '/restart': handleRestart,
};

async function handleRestart(args: string, ctx: CommandContext): Promise<void> {
  const parsed = parseForceArg(args, '/restart [force]');
  if (!parsed.ok) {
    await reply(ctx, parsed.message);
    return;
  }
  const { force } = parsed;
  log.info('command', 'restart', { scope: ctx.scope, force });
  let messageId: string | undefined;
  try {
    const sent = await sendManagedCard(
      ctx.channel,
      ctx.msg.chatId,
      restartCard('starting', undefined, { forced: force }),
      ctx.msg.messageId,
      { track: true, kind: 'restart' },
    );
    messageId = sent.messageId;
  } catch (err) {
    log.fail('command', err, { step: 'restart-card' });
    await reply(ctx, '🔄 正在重启…');
  }
  try {
    // 先等在跑的 run 收尾：kickstart 会连带杀掉它们，队列只在内存里，重启后
    // 那条消息就彻底丢了。与 /release 同一处理。
    if (force) {
      // 显式强制：立即重启，不等在跑的 run（它们会被 kickstart 杀掉）。
      log.info('command', 'restart-force', { busy: !ctx.activeRuns.idle() });
    } else {
      await waitForRunsToDrain(ctx.activeRuns);
    }
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
