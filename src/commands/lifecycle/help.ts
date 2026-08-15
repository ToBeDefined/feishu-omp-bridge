import { helpCard } from '../../card/templates';
import type { CommandContext, Handler } from '../index';

export const helpHandlers: Record<string, Handler> = {
  '/help': handleHelp,
};

async function handleHelp(_args: string, ctx: CommandContext): Promise<void> {
  const card = helpCard();
  await ctx.channel.send(ctx.msg.chatId, { card }, { replyTo: ctx.msg.messageId });
}
