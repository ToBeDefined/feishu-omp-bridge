import { homedir } from 'node:os';
import type { CommandContext, Handler } from '../index';
import { statusCard } from '../../card/templates';
import { getOmpModel, getOmpThinking, getRunIdleTimeoutMs } from '../../config/schema';
import { formatIdleLine } from '../shared';
import { resolveSessionDisplay } from './display';

export const statusHandlers: Record<string, Handler> = {
  '/status': handleStatus,
};

async function handleStatus(_args: string, ctx: CommandContext): Promise<void> {
  // 身份 = 当前会话（一个 OMP 会话 = 一个对话）：cwd 取会话自己的目录，没有会话
  // 时给「无，下条消息新建」而不是崩。
  const scopeCwd = ctx.workspaces.cwdFor(ctx.scope) ?? homedir();
  const active = ctx.workSessions.activeWorkSession(ctx.scope);
  const globalMs = getRunIdleTimeoutMs(ctx.controls.cfg);
  // 名字解析收敛到共享助手：有 title 时零 IO，不再为了显示名字空扫会话目录。
  const { name, topic } = await resolveSessionDisplay(ctx, active);
  const displayName = name ?? topic;
  const card = statusCard({
    cwd: active?.cwd ?? scopeCwd,
    ...(active?.currentSegmentId !== undefined ? { sessionId: active.currentSegmentId } : {}),
    ...(displayName !== undefined ? { sessionName: displayName } : {}),
    sessionStale: Boolean(active?.currentSegmentId !== undefined && active.cwd !== scopeCwd),
    agentName: ctx.agent.displayName,
    scope: ctx.scope,
    chatMode: ctx.chatMode,
    model: getOmpModel(ctx.controls.cfg),
    thinking: getOmpThinking(ctx.controls.cfg),
    idleLine: formatIdleLine(
      ctx.workSessions.getIdleTimeoutMinutes(ctx.scope),
      globalMs ? Math.round(globalMs / 60_000) : 0,
    ),
    createdAt: active?.createdAtMs,
    lastActive: active?.lastActiveAtMs,
    running: ctx.activeRuns.has(ctx.scope),
  });
  await ctx.channel.send(ctx.msg.chatId, { card }, { replyTo: ctx.msg.messageId });
}
