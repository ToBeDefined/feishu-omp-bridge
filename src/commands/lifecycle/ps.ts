import { readAndPrune } from '../../runtime/registry';
import type { CommandContext, Handler } from '../index';
import { reply } from '../shared';
import { formatAgo } from '../../utils/time';
import { psCard, type PsRow } from '../../card/templates';
import { log } from '../../core/logger';

export const psHandlers: Record<string, Handler> = {
  '/ps': handlePs,
};

async function handlePs(_args: string, ctx: CommandContext): Promise<void> {
  const live = readAndPrune();
  log.info('command', 'ps', { count: live.length });
  if (live.length === 0) {
    await reply(ctx, '当前没有 bot 在运行(理论上不可能,你正在跟其中之一对话…)');
    return;
  }
  const rows: PsRow[] = live.map((e) => ({
    id: e.id,
    appId: e.appId,
    ...(e.botName ? { botName: e.botName } : {}),
    startedAgo: formatAgo(Date.now() - new Date(e.startedAt).getTime()),
    isCurrent: e.id === ctx.controls.processId,
  }));
  await ctx.channel.send(
    ctx.msg.chatId,
    { card: psCard(rows) },
    { replyTo: ctx.msg.messageId },
  );
}
