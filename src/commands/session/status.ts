import { homedir } from 'node:os';
import type { CommandContext, Handler } from '../index';
import { statusCard } from '../../card/templates';
import { getOmpModel, getOmpThinking, getRunIdleTimeoutMs } from '../../config/schema';
import { formatIdleLine } from '../shared';
import { resolveWorkSessionDisplay } from './display';

export const statusHandlers: Record<string, Handler> = {
  '/status': handleStatus,
};

async function handleStatus(_args: string, ctx: CommandContext): Promise<void> {
  // 身份 = 当前工作会话：cwd 取它**当前段**（被 touch 那一段），段数/目录数描述
  // 规模；OMP 会话 id 只在「当前段」里出现。没有工作会话时给「无，下条消息新建」
  // 而不是崩。
  const scopeCwd = ctx.workspaces.cwdFor(ctx.scope) ?? homedir();
  const active = ctx.workSessions.activeWorkSession(ctx.scope);
  const globalMs = getRunIdleTimeoutMs(ctx.controls.cfg);
  // 名字解析收敛到共享助手：有 title 时零 IO，不再为了显示名字空扫会话目录。
  const { name, topic } = await resolveWorkSessionDisplay(ctx, active);
  const displayName = name ?? topic;
  const segments = active?.segments ?? [];
  const card = statusCard({
    cwd: active?.cwd ?? scopeCwd,
    ...(active !== undefined ? { workSessionId: active.id } : {}),
    ...(displayName !== undefined ? { workSessionName: displayName } : {}),
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
