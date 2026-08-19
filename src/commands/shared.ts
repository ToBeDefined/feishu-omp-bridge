import { homedir } from 'node:os';
import type { CommandContext } from './index';
import { log } from '../core/logger';
import { forgetManagedCard, updateManagedCard } from '../card/managed';
import { escapeMd } from '../card/templates';

/**
 * Compact text for a one-line display: collapse whitespace, cap length.
 * Plain-text only — does NOT escape markdown. Use `summarizeMd` when the
 * result is rendered into a markdown element (user message content can
 * otherwise inject/break markdown: stray `` ` `` `, `*`, `_`).
 */
export function summarize(text: string, max = 48): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max)}…` : flat;
}

/**
 * Markdown-safe variant of `summarize`: collapse + cap + escape. Order
 * matters — truncate on the raw text first, then escape the clipped result,
 * so a truncation point can never split an escape sequence (`\*`).
 */
export function summarizeMd(text: string, max = 48): string {
  return escapeMd(summarize(text, max));
}

/**
 * Sanitize a value destined for a markdown code span (`` `value` ``): a
 * backtick inside the value would close the span early and scramble the
 * rest of the message. Replace backticks with apostrophes.
 */
export function codeSpan(s: string): string {
  return s.replace(/`/g, "'");
}

/** Delay before in-place card updates, letting the Feishu client settle. */
export const FORM_SETTLE_MS = 1000;

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
      await updateManagedCard(ctx.channel, messageId, {
        schema: '2.0',
        config: { update_multi: true },
        body: {
          elements: [
            { tag: 'markdown', content: '_⚠️ 此卡片已过期，请使用最新发出的卡片。_' },
          ],
        },
      });
      forgetManagedCard(messageId);
    } catch {
      /* not a managed card or update also failed — nothing more to do */
    }
  }
}

/** Compact relative-time label (Chinese, matching CLI output style). */
export function formatAgo(ms: number): string {
  if (ms < 60_000) return `${Math.floor(ms / 1000)} 秒前`;
  if (ms < 3_600_000) return `${Math.floor(ms / 60_000)} 分钟前`;
  if (ms < 86_400_000) return `${Math.floor(ms / 3_600_000)} 小时前`;
  return `${Math.floor(ms / 86_400_000)} 天前`;
}
