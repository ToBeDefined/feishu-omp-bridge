import type {
  ApiMessageItem,
  LarkChannel,
  RawMessageEvent,
} from '@larksuiteoapi/node-sdk';
import { normalize } from '@larksuiteoapi/node-sdk';
import { escapeFramingAttr, neutralizeFraming } from '../agent/omp/args';
import { log } from '../core/logger';
import { expandInteractiveCard } from './interactive-card';

export interface QuotedContext {
  messageId: string;
  senderId: string;
  senderName?: string;
  /** ISO timestamp of the quoted message's creation. Empty when SDK can't
   * resolve it from the fetched item. */
  createdAt: string;
  /** Normalized human-readable content. For text/post this is plain text;
   * for merge_forward the SDK expands the tree into `<forwarded_messages>...
   * </forwarded_messages>` (capped at 50 items by the SDK). */
  content: string;
  rawContentType: string;
}

/**
 * Fetch and normalize the content of a message that the user is reply-quoting.
 *
 * Why this is non-trivial: `im.v1.message.get` returns a flat `ApiMessageItem`
 * list (parent + descendants for merge_forward), but the bot intake pipeline
 * deals in `NormalizedMessage`. We synthesize a `RawMessageEvent` from the
 * parent item and feed it through the SDK's `normalize` so merge_forward gets
 * the same `<forwarded_messages>` expansion path that live events do.
 *
 * `chatId` / `chatType` on the synthesized raw event don't have to be real —
 * normalize doesn't validate them, and downstream only uses the resulting
 * `content`. Same for mentions (we don't pass any).
 */
/**
 * Rewrite an interactive sub-message's body.content so the SDK's
 * `convertInteractive` → `walkCard` finds a text node and emits real card
 * content instead of the literal `[interactive card]` placeholder. We wrap
 * our expanded `<interactive_card>` block as a `plain_text` node — that's
 * one of the three tags walkCard treats as text-bearing
 * (plain_text / lark_md / markdown).
 *
 * This is the merge_forward fix: sub-messages bypass the parent-level
 * expansion because the SDK assembles `<forwarded_messages>` internally from
 * each sub's flattened form, so we have to inject expansion at the sub-fetch
 * layer.
 */
function preExpandInteractive(item: ApiMessageItem): ApiMessageItem {
  if (item.msg_type !== 'interactive') return item;
  const raw = item.body?.content;
  if (typeof raw !== 'string' || raw.length === 0) return item;
  const expanded = expandInteractiveCard('[interactive card]', raw);
  // expandInteractiveCard returns the placeholder unchanged when there's
  // nothing to expand — skip rewriting in that case to avoid double wrapping.
  if (expanded === '[interactive card]') return item;
  const wrapper = JSON.stringify({ tag: 'plain_text', content: expanded });
  return { ...item, body: { ...item.body, content: wrapper } };
}

export async function fetchQuotedContext(
  channel: LarkChannel,
  messageId: string,
): Promise<QuotedContext | undefined> {
  let items: ApiMessageItem[];
  try {
    const r = (await channel.rawClient.im.v1.message.get({
      path: { message_id: messageId },
      // Ask for the original card JSON (incl. v2 user_dsl) instead of the
      // default v1-canonical fallback that strips it. Requires SDK ≥ 1.65.0.
      params: { card_msg_content_type: 'user_card_content' },
    })) as { data?: { items?: ApiMessageItem[] } };
    items = r?.data?.items ?? [];
  } catch (err) {
    log.warn('quote', 'fetch-failed', {
      messageId,
      err: err instanceof Error ? err.message : String(err),
    });
    return undefined;
  }
  const parent = items[0];
  if (!parent || !parent.message_id) return undefined;

  // Reuse the already-fetched items when the SDK re-asks for sub-messages of
  // this same id (merge_forward case). For nested merge_forwards inside, fall
  // back to a fresh API call.
  const fetchSubMessages = async (mid: string): Promise<ApiMessageItem[]> => {
    if (mid === parent.message_id) return items.map(preExpandInteractive);
    try {
      const r = (await channel.rawClient.im.v1.message.get({
        path: { message_id: mid },
        params: { card_msg_content_type: 'user_card_content' },
      })) as { data?: { items?: ApiMessageItem[] } };
      return (r?.data?.items ?? []).map(preExpandInteractive);
    } catch {
      return [];
    }
  };

  const senderOpenId = parent.sender?.id;
  const fakeRaw: RawMessageEvent = {
    sender: { sender_id: { open_id: senderOpenId } },
    message: {
      message_id: parent.message_id,
      // chat_id / chat_type aren't actually used by normalize's converters,
      // but the field is required by the type. Empty strings are safe.
      chat_id: '',
      chat_type: 'group',
      message_type: parent.msg_type ?? 'text',
      content: parent.body?.content ?? '',
      create_time: parent.create_time !== undefined ? String(parent.create_time) : undefined,
      mentions: parent.mentions,
    },
  };

  const botIdentity = channel.botIdentity ?? { openId: '', name: '' };
  try {
    const normalized = await normalize(fakeRaw, {
      botIdentity,
      fetchSubMessages,
      // We want the raw content here, not the trimmed @bot mention form.
      stripBotMentions: false,
    });
    const createMs = parent.create_time
      ? Number.parseInt(String(parent.create_time), 10)
      : 0;
    return {
      messageId: parent.message_id,
      senderId: senderOpenId ?? '',
      senderName: normalized.senderName,
      createdAt: Number.isFinite(createMs) && createMs > 0
        ? new Date(createMs).toISOString()
        : '',
      // For zero-text interactive cards the SDK gave us "[interactive card]"
      // — substitute the raw JSON so OMP can still see what was quoted.
      content: expandInteractiveCard(normalized.content, parent.body?.content),
      rawContentType: parent.msg_type ?? 'text',
    };
  } catch (err) {
    log.warn('quote', 'normalize-failed', {
      messageId,
      err: err instanceof Error ? err.message : String(err),
    });
    return undefined;
  }
}

/**
 * Render one or more quoted contexts as an XML block intended to sit at the
 * top of the prompt body (after `<bridge_context>`, before the user's actual
 * question). Returns empty string when there are no quotes — keeps callers
 * concatenating without conditional checks.
 */
/** Per-quoted-message content cap before it enters the prompt. A reply-quote
 * or forwarded tree can be huge (50 sub-messages); without a cap an
 * adversarial quote blows up the prompt (token cost / OMP timeout). */
const QUOTE_CONTENT_CAP = 8000;

export function renderQuotedBlock(quotes: QuotedContext[]): string {
  if (quotes.length === 0) return '';
  const parts = quotes.map((q) => {
    const attrs = [
      `id="${escapeFramingAttr(q.messageId)}"`,
      q.senderId ? `sender_id="${escapeFramingAttr(q.senderId)}"` : '',
      q.senderName ? `sender_name="${escapeFramingAttr(q.senderName)}"` : '',
      q.createdAt ? `created_at="${escapeFramingAttr(q.createdAt)}"` : '',
      `type="${escapeFramingAttr(q.rawContentType)}"`,
    ]
      .filter(Boolean)
      .join(' ');
    const body =
      q.content.length > QUOTE_CONTENT_CAP
        ? `${q.content.slice(0, QUOTE_CONTENT_CAP)}\n…（引用内容已截断）`
        : q.content;
    // The body is any chat member's message text (including members the
    // access list does not cover) — it must not be able to close the block.
    return `<quoted_message ${attrs}>\n${neutralizeFraming(body)}\n</quoted_message>`;
  });
  return parts.join('\n');
}

/**
 * Extract human-readable text from a raw Feishu message body. `rawContent`
 * is the JSON string from `im.v1.message.list`'s `body.content`. Text and
 * post messages get their text; anything else falls back to a `[type]`
 * marker plus a capped raw prefix so the agent still sees what it is.
 */
export function parseMessageContent(msgType: string, rawContent: string): string {
  if (!rawContent) return '';
  try {
    const parsed = JSON.parse(rawContent) as Record<string, unknown>;
    if (msgType === 'text' && typeof parsed.text === 'string') {
      return parsed.text;
    }
    if (msgType === 'post') {
      const lines: string[] = [];
      const links: string[] = [];
      // post 的标题在 content 之外，单独一个 title 字段。
      const title = typeof parsed.title === 'string' ? parsed.title.trim() : '';
      if (title) lines.push(`【${title}】`);
      for (const block of Array.isArray(parsed.content) ? parsed.content : []) {
        if (!Array.isArray(block)) continue;
        for (const el of block) {
          if (!el || typeof el !== 'object') continue;
          if ('text' in el && typeof el.text === 'string' && el.text.trim()) {
            lines.push(el.text);
          }
          // a 元素（以及带超链接的 text）只保留链接，附在文末。
          if ('href' in el && typeof el.href === 'string' && el.href.trim()) {
            links.push(el.href.trim());
          }
        }
      }
      const out = [...lines.slice(title ? 1 : 0), ...links].join('\n');
      // 纯链接/空 post 可能一行文本都没有——渲染成空引用块没有意义，保证非空。
      if (out.trim() || title) return title ? `【${title}】\n${out}`.trimEnd() : out;
      return '[富文本/链接卡片]';
    }
  } catch {
    /* fall through to raw marker */
  }
  const prefix = rawContent.slice(0, 200);
  return `[${msgType}] ${prefix}`;
}
