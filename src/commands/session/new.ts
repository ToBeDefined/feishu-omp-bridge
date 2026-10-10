import { homedir } from 'node:os';
import type { CommandContext, Handler } from '../index';
import { formatIdleLine, reply } from '../shared';
import { newSessionCard } from '../../card/templates';
import { escapeMd } from '../../utils/text';
import { createBoundChat, defaultChatName } from './group';
import { loadSessionSummary } from './context';
import { getOmpModel, getOmpThinking, getRunIdleTimeoutMs } from '../../config/schema';
import { log } from '../../core/logger';

export const newHandlers: Record<string, Handler> = {
  '/new': handleNew,
  '/reset': handleNew,
};

async function handleNew(args: string, ctx: CommandContext): Promise<void> {
  const trimmed = args.trim();

  // /new chat [name]  — spin up a fresh group chat bound to a fresh session
  if (trimmed === 'chat' || trimmed.startsWith('chat ')) {
    const rawName = trimmed === 'chat' ? '' : trimmed.slice(5).trim();
    return handleNewChat(rawName, ctx);
  }

  const wasRunning = ctx.activeRuns.interrupt(ctx.scope);
  // /new 只重置上下文，不换工作会话：名字（或最后一条用户消息）要带进卡片，
  // 用户才知道自己还在同一摊活里。先取名字再丢当前段。
  const workSessionName = await resolveWorkSessionName(ctx);
  ctx.workSessions.dropCurrentSegment(ctx.scope);
  // A new session invalidates any pending /ws undo: rolling back would also
  // clear the session the user just started.
  ctx.workspaces.clearUndo(ctx.scope);
  const globalMs = getRunIdleTimeoutMs(ctx.controls.cfg);
  const card = newSessionCard({
    cwd: ctx.workspaces.cwdFor(ctx.scope) ?? homedir(),
    model: getOmpModel(ctx.controls.cfg),
    thinking: getOmpThinking(ctx.controls.cfg),
    idleLine: formatIdleLine(
      ctx.workSessions.getIdleTimeoutMinutes(ctx.scope),
      globalMs ? Math.round(globalMs / 60_000) : 0,
    ),
    wasRunning,
    scopeNote: ctx.chatMode === 'topic' ? '话题独立会话' : undefined,
    ...(workSessionName !== undefined ? { workSessionName } : {}),
  });
  try {
    await ctx.channel.send(ctx.msg.chatId, { card }, { replyTo: ctx.msg.messageId });
  } catch (err) {
    log.fail('command', err, { step: 'new-card' });
    await reply(ctx, wasRunning ? '已中断当前任务并重置上下文。' : '已重置上下文。');
  }
}

/**
 * 工作会话的显示名：`/rename` 起的名字优先，无名时回退到该工作会话**最近一段**
 * 的最后一条用户消息。两者都拿不到时返回 undefined——卡片上不显示，绝不硬编码
 * 「未命名」。只试最近 1 个段：`loadSessionSummary` 每次都全目录扫描，逐段回退
 * 在大工作会话上开销线性放大，而最近一段就是用户最可能记得的那条消息。
 */
async function resolveWorkSessionName(ctx: CommandContext): Promise<string | undefined> {
  const active = ctx.workSessions.activeWorkSession(ctx.scope);
  if (!active) return undefined;
  const named = active.title?.trim();
  if (named) return named;
  const seg = active.segments[active.segments.length - 1];
  if (!seg) return undefined;
  const { lastMessage } = await loadSessionSummary(ctx, seg.sessionId);
  const msg = lastMessage.trim();
  return msg || undefined;
}

async function handleNewChat(rawName: string, ctx: CommandContext): Promise<void> {
  const sourceCwd = ctx.workspaces.cwdFor(ctx.scope);
  const name = rawName || defaultChatName();

  let created;
  try {
    created = await createBoundChat({
      channel: ctx.channel,
      name,
      inviteOpenId: ctx.msg.senderId,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    await reply(ctx, `❌ 创建群失败：${msg}\n\n确认 bot 已开启 \`im:chat\` 权限。`);
    return;
  }

  // Inherit cwd from the originating chat so the new group starts in the
  // same workspace; otherwise it'll fall back to $HOME.
  if (sourceCwd) {
    ctx.workspaces.setCwd(created.chatId, sourceCwd);
  }

  const welcome = sourceCwd
    ? `🎉 群已建好，cwd 继承自原群：\`${sourceCwd}\`\n\n@我 + 任意消息开始对话。`
    : '🎉 群已建好。\n\n@我 + 任意消息开始对话。';
  try {
    await ctx.channel.send(created.chatId, { markdown: welcome });
  } catch (err) {
    console.warn('[new-chat] welcome message failed:', err);
  }

  await reply(ctx, `✅ 已创建群 **${escapeMd(created.name)}**，去新群里继续。`);
}
