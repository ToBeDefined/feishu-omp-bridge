import type { CommandContext, Handler } from '../index';
import { statusCard } from '../../card/templates';
import { collectContextInfo, loadSessionSummary } from './context';
import { resolveConversationCwd } from '../../session/current-cwd';

/**
 * 会话状态卡：`/status` 是主名，`/context` 与 `/ctx` 是别名 —— 三者同一张卡
 * （会话 / 环境 / 最近内容），不再有「状态卡」与「上下文卡」两份近似输出。
 */
export const statusHandlers: Record<string, Handler> = {
  '/status': handleStatus,
  '/context': handleStatus,
  '/ctx': handleStatus,
};

async function handleStatus(_args: string, ctx: CommandContext): Promise<void> {
  const entry = ctx.sessions.getRaw(ctx.scope);
  // 「下一条消息实际会跑在哪」：会话目录还在就用它（窗口 cwd 跟随），目录没了
  // 则退回窗口 cwd / $HOME 并回写 —— 因此 resumable 缺失正说明当前会话已失效。
  const { cwd, sessionId: resumable } = await resolveConversationCwd(
    ctx.workspaces,
    ctx.sessions,
    ctx.scope,
  );
  const sessionId = entry?.sessionId;
  // 最近内容要读会话文件（唯一一处读盘）：没有当前会话就没有内容可读。
  const summary =
    sessionId !== undefined
      ? await loadSessionSummary(ctx, sessionId)
      : { lastMessage: '', lastReply: '' };
  const card = statusCard(
    collectContextInfo(ctx, summary, {
      cwd,
      sessionStale: sessionId !== undefined && resumable === undefined,
    }),
  );
  await ctx.channel.send(ctx.msg.chatId, { card }, { replyTo: ctx.msg.messageId });
}
