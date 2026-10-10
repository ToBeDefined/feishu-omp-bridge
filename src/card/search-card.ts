import { codeSpan, summarize } from '../commands/shared';
import { escapeMd } from './templates';
import { formatAgoOr } from '../utils/time';

/**
 * Search result card rendering (moved out of commands/session/search.ts so
 * the card layer owns all Feishu card output, matching model-card /
 * config-card / account-cards).
 */

export interface SearchHit {
  role: 'user' | 'assistant';
  content: string;
  timestamp?: string;
}

export interface SearchContext {
  messages: SearchHit[];
  hitIndex: number;
  sessionId?: string;
  workspace?: string;
  /** Number of matched Q&A pairs in the session; >1 when grouped. */
  matchCount?: number;
  /** User-assigned session title (/rename), when the hit belongs to one. */
  title?: string;
}

export function renderSearchContext(
  context: SearchContext,
  mode: 'compact' | 'detail' = 'compact',
  keyword?: string,
): string {
  return context.messages
    .map((m, i) => {
      const role = m.role === 'user' ? '🧑 **你**' : '🤖 **助手**';
      const marker = i === context.hitIndex ? '📍' : '';
      // Cap each message; compact keeps the list tight, detail shows more.
      // Assistant answers get more room than the (usually shorter) question.
      const max =
        mode === 'detail' ? (m.role === 'user' ? 600 : 1000) : m.role === 'user' ? 80 : 120;
      const escaped = highlightKeyword(
        escapeSearchContent(summarize(m.content, max)),
        keyword,
      );
      // Markdown: role label on its own line, message content as a block
      // quote so longer snippets wrap nicely and stay visually grouped.
      // Every line gets the quote prefix — a multi-line snippet would
      // otherwise only quote its first line.
      const quoted = escaped
        .split('\n')
        .map((line) => `> ${line}`)
        .join('\n');
      return `${marker}${role}\n${quoted}`;
    })
    .join('\n\n');
}

/**
 * Wrap keyword occurrences (case-insensitive) in bold — applied AFTER
 * markdown escaping so both sides share the same escaped form and the
 * regex stays injection-safe.
 */
function highlightKeyword(escapedText: string, keyword: string | undefined): string {
  if (!keyword) return escapedText;
  let regex: RegExp;
  try {
    regex = new RegExp(escapeMd(keyword), 'gi');
  } catch {
    return escapedText;
  }
  return escapedText.replace(regex, (m) => `**${m}**`);
}

/** Newest message timestamp of a hit, for the relative-time meta line. */
function lastHitTime(context: SearchContext): number | undefined {
  const stamps = context.messages
    .map((m) => m.timestamp)
    .filter((t): t is string => Boolean(t))
    .map((t) => Date.parse(t))
    .filter((n) => Number.isFinite(n));
  return stamps.length > 0 ? Math.max(...stamps) : undefined;
}

/**
 * Neutralise untrusted message content before embedding into card markdown:
 * `escapeMd` kills inline markdown (incl. `[x](url)` / `![](url)` links and
 * images), then line-leading `#` / `>` are escaped so the snippet can't turn
 * into a heading or nest quotes inside its blockquote.
 *
 * Expects raw (only whitespace-collapsed/truncated) text — callers must not
 * pre-escape, or the backslashes would double up.
 */
function escapeSearchContent(text: string): string {
  return escapeMd(text)
    .split('\n')
    .map((line) => (line.startsWith('#') || line.startsWith('>') ? `\\${line}` : line))
    .join('\n');
}

const SEARCH_PAGE_SIZE = 6;

export function searchResultsCard(
  keyword: string,
  contexts: SearchContext[],
  queryId: string,
  showButtons = true,
  offset = 0,
): object {
  const done = !showButtons;
  const shown = done ? contexts : contexts.slice(offset, offset + SEARCH_PAGE_SIZE);
  const remaining = contexts.length - (offset + shown.length);
  const range =
    offset > 0 || remaining > 0
      ? ` · 第 ${offset + 1}-${offset + shown.length} 个`
      : '';
  const header = done
    ? `✅ 搜索完成 · ${contexts.length} 个会话`
    : `🔍 搜索 \`${codeSpan(keyword)}\`：找到 ${contexts.length} 个会话${range}`;
  // Active list pages 6 per card; the done (settled) view renders everything
  // for review.
  const blocks: object[] = [];
  shown.forEach((c, i) => {
    const globalIdx = offset + i;
    const ago = formatAgoOr(lastHitTime(c), '');
    const metaLine = [
      c.title ? `🏷 ${c.title}` : '',
      c.workspace ? `📁 ${c.workspace}` : '',
      c.sessionId ? `🆔 ${c.sessionId}` : '',
      ago ? `🕘 ${ago}` : '',
      c.matchCount && c.matchCount > 1 ? `🔎 ${c.matchCount} 处匹配` : '',
    ]
      .filter(Boolean)
      .join(' · ');
    const title = `#${globalIdx + 1}${metaLine ? ` · ${metaLine}` : ''}`;
    blocks.push(
      // Heading-size title so the item number / workspace / session stands
      // out; the conversation snippet below it stays at normal size.
      { tag: 'markdown', content: title, text_size: 'heading' },
      { tag: 'markdown', content: renderSearchContext(c, 'compact', keyword) },
    );
    if (showButtons) {
      blocks.push(
        {
          tag: 'column_set',
          flex_mode: 'flow',
          horizontal_spacing: 'small',
          columns: [
            {
              tag: 'column',
              width: 'auto',
              elements: [
                {
                  tag: 'button',
                  text: { tag: 'plain_text', content: '查看详情' },
                  type: 'default',
                  value: { cmd: 'search.show', arg: `${queryId} ${globalIdx + 1}` },
                },
              ],
            },
            {
              tag: 'column',
              width: 'auto',
              elements: [
                {
                  tag: 'button',
                  text: { tag: 'plain_text', content: '继续对话' },
                  type: 'primary',
                  value: { cmd: 'search.resume', arg: c.sessionId },
                },
              ],
            },
          ],
        },
      );
    }
    const lastOfPage = i === shown.length - 1;
    if (!lastOfPage || (showButtons && (remaining > 0 || offset > 0))) {
      blocks.push({ tag: 'hr' });
    }
  });
  if (showButtons) {
    const pageButtons: object[] = [];
    if (offset > 0) {
      pageButtons.push({
        tag: 'button',
        text: { tag: 'plain_text', content: '↑ 上一页' },
        type: 'default',
        value: { cmd: 'search.page', arg: `${queryId} ${Math.max(0, offset - SEARCH_PAGE_SIZE)}` },
      });
    }
    if (remaining > 0) {
      pageButtons.push({
        tag: 'button',
        text: { tag: 'plain_text', content: `↓ 下一页（剩 ${remaining}）` },
        type: 'default',
        value: { cmd: 'search.page', arg: `${queryId} ${offset + SEARCH_PAGE_SIZE}` },
      });
    }
    pageButtons.push({
      tag: 'button',
      text: { tag: 'plain_text', content: '完成' },
      type: 'default',
      value: { cmd: 'search.done', arg: queryId },
    });
    blocks.push({
      tag: 'column_set',
      flex_mode: 'flow',
      horizontal_spacing: 'small',
      columns: pageButtons.map((b) => ({
        tag: 'column',
        width: 'auto',
        elements: [b],
      })),
    });
  }
  return {
    schema: '2.0',
    config: { summary: { content: '搜索结果' } },
    body: {
      elements: [{ tag: 'markdown', content: header }, { tag: 'hr' }, ...blocks],
    },
  };
}

/** Empty-hit card: friendlier than a bare text reply. */
export function searchEmptyCard(keyword: string): object {
  return {
    schema: '2.0',
    config: { summary: { content: '未找到匹配消息' } },
    body: {
      elements: [
        {
          tag: 'markdown',
          content: `🔍 没有找到包含 \`${codeSpan(keyword)}\` 的消息。\n\n_换个关键词，或缩短关键词再试。_`,
        },
      ],
    },
  };
}

export function searchDetailCard(
  sessionId: string | undefined,
  content: string,
  queryRef?: string,
  idx?: number,
  done = false,
  workspace?: string,
): object {
  const label = idx !== undefined ? `搜索结果 #${idx}` : '搜索详情';
  const parts = [
    label,
    workspace ? `📁 ${workspace}` : '',
    sessionId ? `🆔 ${sessionId}` : '',
  ].filter(Boolean);
  // Done state keeps the full header (number / workspace / session) — only
  // the buttons are stripped. "✅" marks it as settled.
  const head = parts.length > 0 ? `✅ ${parts.join(' · ')}` : '✅ 搜索详情';
  const elements: object[] = [
    { tag: 'markdown', content: head },
    { tag: 'hr' },
    { tag: 'markdown', content },
  ];
  if (!done) {
    elements.push(
      { tag: 'hr' },
      {
        tag: 'column_set',
        flex_mode: 'flow',
        horizontal_spacing: 'small',
        columns: [
          {
            tag: 'column',
            width: 'auto',
            elements: [
              {
                tag: 'button',
                text: { tag: 'plain_text', content: '继续对话' },
                type: 'primary',
                value: { cmd: 'search.resume', arg: sessionId ?? '' },
              },
            ],
          },
          {
            tag: 'column',
            width: 'auto',
            elements: [
              {
                tag: 'button',
                text: { tag: 'plain_text', content: '完成' },
                type: 'default',
                value: { cmd: 'search.done', arg: queryRef ?? '' },
              },
            ],
          },
        ],
      },
    );
  }
  return {
    schema: '2.0',
    config: { summary: { content: '搜索详情' } },
    body: { elements },
  };
}
