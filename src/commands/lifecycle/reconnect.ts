import type { CommandContext, Handler } from '../index';
import { reply } from '../shared';
import { log } from '../../core/logger';

export const reconnectHandlers: Record<string, Handler> = {
  '/reconnect': handleReconnect,
};

async function handleReconnect(_args: string, ctx: CommandContext): Promise<void> {
  log.info('command', 'reconnect');
  await reply(ctx, '⏳ 正在重连…');
  try {
    await ctx.controls.restart();
    log.info('command', 'reconnect-ok');
  } catch (err) {
    log.fail('command', err, { step: 'reconnect' });
    await reply(ctx, `❌ 重连失败:${err instanceof Error ? err.message : String(err)}`);
  }
}
