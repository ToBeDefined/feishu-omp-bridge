import { homedir } from 'node:os';
import type { CommandContext, Handler } from '../index';
import { statusCard } from '../../card/templates';
import { getOmpModel, getOmpThinking, getRunIdleTimeoutMs } from '../../config/schema';
import { formatIdleLine } from '../shared';
import { loadSessionSummary, sampleSegmentId } from './context';

export const statusHandlers: Record<string, Handler> = {
  '/status': handleStatus,
};

async function handleStatus(_args: string, ctx: CommandContext): Promise<void> {
  // 身份 = 当前工作会话：cwd 取它最新段，段数/目录数描述规模；OMP 会话 id 只在
  // 「当前段」里出现。没有工作会话时给「无，下条消息新建」而不是崩。
  const scopeCwd = ctx.workspaces.cwdFor(ctx.scope) ?? homedir();
  const active = ctx.workSessions.activeWorkSession(ctx.scope);
  const globalMs = getRunIdleTimeoutMs(ctx.controls.cfg);
  const sampleId = sampleSegmentId(active);
  const summary =
    sampleId !== undefined
      ? await loadSessionSummary(ctx, sampleId)
      : { lastMessage: '', lastReply: '' };
  const segments = active?.segments ?? [];
  const name = active?.title?.trim() || summary.lastMessage?.trim() || undefined;
  const card = statusCard({
    cwd: active?.cwd ?? scopeCwd,
    ...(active !== undefined ? { workSessionId: active.id } : {}),
    ...(name !== undefined ? { workSessionName: name } : {}),
    segmentCount: segments.length,
    cwdCount: new Set(segments.map((s) => s.cwd)).size,
    ...(active?.currentSegmentId !== undefined
      ? { currentSessionId: active.currentSegmentId }
      : {}),
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
