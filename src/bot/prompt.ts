import type { NormalizedMessage } from '@larksuiteoapi/node-sdk';
import type { LocalAttachment } from '../media/cache';
import type { QuotedContext } from './quote';
import { expandInteractiveCard } from './interactive-card';
import { renderQuotedBlock } from './quote';

/**
 * For interactive-card messages the SDK flattens to text-bearing nodes or
 * the literal "[interactive card]" placeholder, losing v2 `user_dsl` and the
 * raw v1 JSON. Pull the raw webhook content (attached via `includeRawEvent`)
 * and feed it to `expandInteractiveCard` so direct-receive cards get the
 * same `<interactive_card>` injection that quoted cards already get.
 */
export function expandedMessageContent(m: NormalizedMessage): string {
  if (m.rawContentType !== 'interactive') return m.content;
  const rawContent = (m.raw as { message?: { content?: unknown } } | undefined)
    ?.message?.content;
  if (typeof rawContent !== 'string') return m.content;
  return expandInteractiveCard(m.content, rawContent);
}

export function buildPrompt(
  batch: NormalizedMessage[],
  attachments: LocalAttachment[],
  quotes: QuotedContext[] = [],
): string {
  const fileKeys = batch.flatMap((m) => m.resources.map((r) => r.fileKey));
  const texts = batch
    .map((m) => stripAttachmentRefs(expandedMessageContent(m), fileKeys).trim())
    .filter(Boolean);
  const ctxHeader = buildBridgeContextHeader(batch);
  const quoteBlock = renderQuotedBlock(quotes);

  // Order: <bridge_context> (metadata) → <quoted_message>(s) (what user is
  // pointing at) → user text + attachments (what they're asking).
  const prefixParts = [ctxHeader, quoteBlock].filter(Boolean);
  const prefix = prefixParts.length > 0 ? `${prefixParts.join('\n\n')}\n\n` : '';

  if (attachments.length === 0) {
    return `${prefix}${texts.join('\n\n')}`;
  }

  const attachLines = attachments.map((a) => {
    const label =
      a.kind === 'image'
        ? '图片'
        : a.kind === 'audio'
          ? '音频'
          : a.kind === 'video'
            ? '视频'
            : '文件';
    const name = a.originalName ? ` (${a.originalName})` : '';
    return `- ${a.path}${name} — ${label}`;
  });
  const userPart = texts.length > 0 ? texts.join('\n\n') : '请看下面的附件。';
  return `${prefix}${userPart}\n\n附件（本地路径）：\n${attachLines.join('\n')}`;
}

export function buildBridgeContextHeader(batch: NormalizedMessage[]): string {
  const m = batch[0];
  if (!m) return '';
  const lines = [
    '<bridge_context>',
    `chat_id: ${m.chatId}`,
    `chat_type: ${m.chatType}`,
    `sender_id: ${m.senderId}`,
  ];
  if (m.senderName) lines.push(`sender_name: ${m.senderName}`);
  if (m.threadId) lines.push(`thread_id: ${m.threadId}`);
  lines.push('</bridge_context>');
  return lines.join('\n');
}

export function stripAttachmentRefs(text: string, fileKeys: string[]): string {
  if (!text || fileKeys.length === 0) return text;
  let out = text;
  for (const key of fileKeys) {
    const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    out = out.replace(new RegExp(`!?\\[[^\\]]*\\]\\(${escaped}\\)`, 'g'), '');
  }
  return out.replace(/\n{3,}/g, '\n\n');
}
