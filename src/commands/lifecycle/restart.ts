import type { CommandContext, Handler } from '../index';
import { reply, RESTART_FLUSH_GRACE_MS } from '../shared';
import { log } from '../../core/logger';
import { clearOnlineNotice, markOnlineNotice } from '../../bot/online-notify';

export const restartHandlers: Record<string, Handler> = {
  '/restart': handleRestart,
};

async function handleRestart(_args: string, ctx: CommandContext): Promise<void> {
  log.info('command', 'restart', { scope: ctx.scope });
  await reply(ctx, `🔄 正在重启…`);
  try {
    // Record the requester before the process dies: the boot notice otherwise
    // only reaches chats with a persisted session, and /new, /cd and /ws all
    // clear the entry — a restart right after them used to look like a crash.
    await markOnlineNotice(ctx.msg.chatId, 'notify');
    // 让上面的回复先 flush 到飞书，否则 kickstart 的 SIGTERM 会把它丢掉。
    await new Promise((resolve) => setTimeout(resolve, RESTART_FLUSH_GRACE_MS));
    const realRestart = await ctx.controls.restartProcess();
    // True restart (launchd kickstart -k): this process is about to die and
    // the daemon relaunches with newly built code — no "done" ack can be
    // sent from here. Fallback (not under launchd): in-process reconnect,
    // which can ack.
    if (!realRestart) {
      // No boot will consume the marker — drop it rather than leak a stale
      // "已上线" into some later boot.
      await clearOnlineNotice();
      await reply(ctx, '🚀 重启完成，已重新连接。');
    }
    log.info('command', 'restart-ok', { realRestart });
  } catch (err) {
    log.fail('command', err, { step: 'restart' });
    await clearOnlineNotice();
    await reply(ctx, '❌ 重启失败，bot 仍在线。');
  }
}
