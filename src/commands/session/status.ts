import { homedir } from 'node:os';
import type { CommandContext, Handler } from '../index';
import { statusCard } from '../../card/templates';
import { getOmpModel, getOmpThinking, getRunIdleTimeoutMs } from '../../config/schema';
import { formatIdleLine } from '../shared';

export const statusHandlers: Record<string, Handler> = {
  '/status': handleStatus,
};

async function handleStatus(_args: string, ctx: CommandContext): Promise<void> {
  const cwd = ctx.workspaces.cwdFor(ctx.scope) ?? homedir();
  const sess = ctx.sessions.getRaw(ctx.scope);
  const globalMs = getRunIdleTimeoutMs(ctx.controls.cfg);
  const card = statusCard({
    cwd,
    sessionId: sess?.sessionId,
    sessionTitle: sess?.title,
    sessionStale: Boolean(sess && sess.cwd !== cwd),
    agentName: ctx.agent.displayName,
    scope: ctx.scope,
    chatMode: ctx.chatMode,
    model: getOmpModel(ctx.controls.cfg),
    thinking: getOmpThinking(ctx.controls.cfg),
    idleLine: formatIdleLine(
      ctx.sessions.getIdleTimeoutMinutes(ctx.scope),
      globalMs ? Math.round(globalMs / 60_000) : 0,
    ),
    createdAt: sess?.createdAt,
    lastActive: sess?.updatedAt,
    running: ctx.activeRuns.has(ctx.scope),
  });
  await ctx.channel.send(ctx.msg.chatId, { card }, { replyTo: ctx.msg.messageId });
}
