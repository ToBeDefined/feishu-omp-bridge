import type { NormalizedMessage } from '@larksuiteoapi/node-sdk';
import { flattenFramingLine } from '../agent/omp/args';
import { codeFence } from '../card/templates';
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
  unresolvedFileKeys: string[] = [],
): string {
  // Only strip the `![name](file_key)` marker for resources that actually
  // resolved — a failed download must leave a visible trace in the prompt, or
  // the agent sees a message that simply has no attachment.
  const resolvedKeys = attachments
    .map((a) => a.fileKey)
    .filter((key): key is string => typeof key === 'string');
  const texts = batch
    .map((m) => stripAttachmentRefs(expandedMessageContent(m), resolvedKeys).trim())
    .filter(Boolean);
  const ctxHeader = buildBridgeContextHeader(batch);
  const quoteBlock = renderQuotedBlock(quotes);
  const missingLines = unresolvedFileKeys.map((key) => `- ⚠️ 附件未能下载：${key}`);

  // Order: <bridge_context> (metadata) → <quoted_message>(s) (what user is
  // pointing at) → user text + attachments (what they're asking).
  const prefixParts = [ctxHeader, quoteBlock].filter(Boolean);
  const prefix = prefixParts.length > 0 ? `${prefixParts.join('\n\n')}\n\n` : '';

  if (attachments.length === 0) {
    const warn = missingLines.length > 0 ? `\n\n附件：\n${missingLines.join('\n')}` : '';
    return `${prefix}${texts.join('\n\n')}${warn}`;
  }

  const attachLines = attachments.map((a) => {
    const label =
      a.kind === 'image'
        ? '图片'
        : a.kind === 'audio'
          ? '语音'
          : a.kind === 'video'
            ? '视频'
            : '文件';
    const name = a.originalName ? ` (${a.originalName})` : '';
    const line = `- ${a.path}${name} — ${label}`;
    // Text-like files: inline the extracted content directly so the agent
    // reads what the user sent without an extra tool call.
    if (a.kind === 'file' && a.content !== undefined) {
      return `${line}\n  内容：\n${codeFence(a.content)}`;
    }
    // Voice/video messages carry their transcript inline so the agent reads
    // the content without needing to decode the media.
    return (a.kind === 'audio' || a.kind === 'video') && a.transcript
      ? `${line}\n  转写: ${a.transcript}`
      : line;
  });
  const userPart = texts.length > 0 ? texts.join('\n\n') : '请看下面的附件。';
  const allAttachLines = [...attachLines, ...missingLines];
  return `${prefix}${userPart}\n\n附件（本地路径）：\n${allAttachLines.join('\n')}`;
}

export function buildBridgeContextHeader(batch: NormalizedMessage[]): string {
  const m = batch[0];
  if (!m) return '';
  const lines = [
    '<bridge_context>',
    `chat_id: ${flattenFramingLine(m.chatId)}`,
    `chat_type: ${flattenFramingLine(m.chatType)}`,
    `sender_id: ${flattenFramingLine(m.senderId)}`,
  ];
  // A display name is chosen by the member themselves; it must not be able to
  // close the block or inject extra metadata lines.
  if (m.senderName) lines.push(`sender_name: ${flattenFramingLine(m.senderName)}`);
  if (m.threadId) lines.push(`thread_id: ${flattenFramingLine(m.threadId)}`);
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
