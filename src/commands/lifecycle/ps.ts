import { readAndPrune } from '../../runtime/registry';
import type { CommandContext, Handler } from '../index';
import { reply } from '../shared';
import { formatAgo } from '../../utils/time';
import { psCard, type PsRow } from '../../card/templates';
import { log } from '../../core/logger';

export const psHandlers: Record<string, Handler> = {
  '/ps': handlePs,
};

/** Live rows straight from the registry (pruned). Exported so the exit confirm
 * flow (`exit.ts`) re-renders the same card without touching the registry
 * differently from `/ps` itself. */
export function psRowsFromRegistry(processId?: string): PsRow[] {
  return readAndPrune().map((e) => ({
    id: e.id,
    appId: e.appId,
    ...(e.botName ? { botName: e.botName } : {}),
    startedAgo: formatAgo(Date.now() - new Date(e.startedAt).getTime()),
    isCurrent: e.id === processId,
  }));
}

async function handlePs(_args: string, ctx: CommandContext): Promise<void> {
  const rows = psRowsFromRegistry(ctx.controls.processId);
  log.info('command', 'ps', { count: rows.length });
  if (rows.length === 0) {
    await reply(ctx, '当前没有 bot 在运行(理论上不可能,你正在跟其中之一对话…)');
    return;
  }
  await ctx.channel.send(
    ctx.msg.chatId,
    { card: psCard(rows) },
    { replyTo: ctx.msg.messageId },
  );
}
