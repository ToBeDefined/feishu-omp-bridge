import { homedir } from 'node:os';
import type { CommandContext, Handler } from '../index';
import { statusCard } from '../../card/templates';
import { getOmpModel, getOmpThinking, getRunIdleTimeoutMs } from '../../config/schema';
import { formatIdleLine } from '../shared';
import { sessionName } from './display';
import { resolveConversationCwd } from '../../session/current-cwd';

export const statusHandlers: Record<string, Handler> = {
  '/status': handleStatus,
};

async function handleStatus(_args: string, ctx: CommandContext): Promise<void> {
  // 身份 = 当前会话（一个 OMP 会话 = 一个对话）：cwd 取会话自己的目录，没有会话
  // 时给「无，下条消息新建」而不是崩。
  const active = ctx.workSessions.activeWorkSession(ctx.scope);
  // 会话优先：有当前会话就报它自己的目录（窗口的 cwd 跟随它一起走）。
  const { cwd, sessionId: resumable } = await resolveConversationCwd(
    ctx.workspaces,
    ctx.workSessions,
    ctx.scope,
  );
  const globalMs = getRunIdleTimeoutMs(ctx.controls.cfg);
  // 名字 = 真标题（/rename 起的），没有就不显示标题行；**不拿最后一条消息冒充**。
  const displayName = sessionName(active);
  const card = statusCard({
    cwd,
    ...(active?.currentSegmentId !== undefined ? { sessionId: active.currentSegmentId } : {}),
    ...(displayName !== undefined ? { sessionName: displayName } : {}),
    // 真的换会话信号只有一个：当前会话的目录已不可用（下一条消息会新建对话）。
    // 「窗口 cwd 与会话不一致」不算 —— 运行时 cwd 以会话为准，窗口会跟着它走。
    sessionStale: active?.currentSegmentId !== undefined && resumable === undefined,
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
