import { homedir } from 'node:os';
import type { CommandContext } from './index';
import { log } from '../core/logger';
import { forgetManagedCard, updateManagedCard } from '../card/managed';
import { staleNoticeCard } from '../card/templates';

/** Rendered idle-timeout line: scope override wins over the global default. */
export function formatIdleLine(
  scopeMinutes: number | undefined,
  globalMinutes: number,
): string {
  if (scopeMinutes !== undefined) {
    return scopeMinutes > 0 ? `本会话 ${scopeMinutes} 分钟` : '本会话已关闭';
  }
  return globalMinutes > 0 ? `全局 ${globalMinutes} 分钟` : '未启用（不自动中断任务）';
}

/** Delay before in-place card updates, letting the Feishu client settle. */
export const FORM_SETTLE_MS = 1000;

/**
 * Grace wait before bouncing the process (/release, /restart): text replies
 * travel the WS pipeline, and launchd's SIGTERM drops not-yet-flushed
 * outbound frames — the release/restart notices used to vanish silently.
 * Latest measured round-trip leaves plenty of headroom at 800ms.
 */
export const RESTART_FLUSH_GRACE_MS = 800;

/**
 * Send a plain markdown reply, swallowing any send error. Used by command
 * handlers where a failed reply shouldn't bubble up and crash the bot —
 * losing the message is better than dying.
 */
export async function reply(ctx: CommandContext, markdown: string): Promise<void> {
  try {
    await ctx.channel.send(ctx.msg.chatId, { markdown }, { replyTo: ctx.msg.messageId });
  } catch (err) {
    log.fail('command', err, { step: 'reply' });
  }
}

export function expandTilde(p: string): string {
  if (p === '~') return homedir();
  if (p.startsWith('~/')) return `${homedir()}${p.slice(1)}`;
  return p;
}

/**
 * 把表单 / 选择器卡片原地收尾成终态（已取消 / 已过期）。
 *
 * 卡片可能**不在本进程的托管表里**：重启前发出的老卡片、或卡片是在 bridge 之外发的
 * （手工调试）。此时原地更新必然失败 —— 不能静默，否则用户点了「取消」什么都不发生，
 * 看起来就是坏了。退回一条简短回复。
 */
export async function settleManagedCard(
  ctx: CommandContext,
  card: object,
  fallbackText: string,
): Promise<void> {
  const messageId = ctx.msg.messageId;
  await new Promise((r) => setTimeout(r, FORM_SETTLE_MS));
  // 1) 首选：托管卡片走 CardKit 更新（带 sequence，能做流式 / 多次更新）。
  try {
    await updateManagedCard(ctx.channel, messageId, card);
    forgetManagedCard(messageId);
    return;
  } catch (err) {
    log.warn('command', 'card-settle-fallback', { messageId, err: String(err) });
  }
  // 2) 退而求其次：把消息内容整体 patch 成新卡片 —— 对「bridge 之外发的卡片」
  //    （手工调试）与「重启前的老卡片」都有效，用户看到卡片真的变成「已取消」。
  try {
    await ctx.channel.rawClient.im.v1.message.patch({
      path: { message_id: messageId },
      data: { content: JSON.stringify(card) },
    });
    return;
  } catch (err) {
    log.warn('command', 'card-patch-failed', { messageId, err: String(err) });
  }
  // 3) 两条都不行：至少回一句，别让点击看起来没发生。
  await reply(ctx, fallbackText);
}

export async function recallMessage(ctx: CommandContext, messageId: string): Promise<void> {
  try {
    await ctx.channel.rawClient.im.v1.message.delete({
      path: { message_id: messageId },
    });
  } catch (err) {
    // Recall failed — the old card stays in the chat with live buttons.
    // Neutralize it in place (managed cards only) instead of leaving a
    // second clickable flow stacked under the new card.
    log.warn('command', 'recall-failed', { messageId, err: String(err) });
    try {
      await updateManagedCard(ctx.channel, messageId, staleNoticeCard());
      forgetManagedCard(messageId);
    } catch {
      /* not a managed card or update also failed — nothing more to do */
    }
  }
}
