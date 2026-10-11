import { codeSpan, summarize, summarizeMd } from '../utils/text';
import { escapeMd } from '../utils/text';
import { formatAgoOr } from '../utils/time';
import { actions, shortSessionId, type ButtonSpec } from './templates';

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

/** One OMP session's matched Q&A pairs (one session = one conversation). */
export interface SearchHitGroup {
  /** 遗留字段：单一会话模型下不再用于分块标注，保留以兼容收集方。 */
  segmentId?: string;
  messages: SearchHit[];
  hitIndex: number;
  /** Matched Q&A pairs within this group. */
  matchCount: number;
}

/**
 * One search row = one conversation (one OMP session): every matched Q&A pair
 * that session contains collapses under a single heading.
 */
export interface SearchContext {
  /** OMP session id — the row's identity and the resume target. */
  sessionId: string;
  /** User-assigned title (/rename), when the session is named. */
  title?: string;
  /** Display fallback when unnamed: the session's last user message. */
  topic?: string;
  workspace?: string;
  /** 遗留字段：单一会话模型下不再渲染，保留以兼容收集方。 */
  segmentCount?: number;
  /** Σ matched Q&A pairs; `🔎` is shown only when >1. */
  matchCount: number;
  /** Matched pairs per source group. */
  groups: SearchHitGroup[];
  /** Newest group's pair — the detail view's default snippet. */
  messages: SearchHit[];
  hitIndex: number;
}

export function renderSearchContext(
  context: { messages: SearchHit[]; hitIndex: number },
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
    // Identity line is heading-sized; everything else drops to a small grey
    // meta line. Blending a 36-char id and the workspace path into the heading
    // produced several lines of oversized text per result on a phone.
    // Identity = the session's name, else its topic fallback (last user
    // message); never an invented title.
    const identity = c.title
      ? `🏷 ${escapeMd(c.title)}`
      : c.topic
        ? `**${summarizeMd(c.topic, 24)}**`
        : '';
    const heading = [`#${globalIdx + 1}`, identity].filter(Boolean).join(' · ');
    const metaLine = [
      c.workspace ? `📁 ${escapeMd(c.workspace)}` : '',
      ago ? `🕘 ${ago}` : '',
      c.matchCount > 1 ? `🔎 ${c.matchCount} 处匹配` : '',
      // Identity handle of the session — the full id is in 查看详情.
      `🆔 ${shortSessionId(c.sessionId)}`,
    ]
      .filter(Boolean)
      .join(' · ');
    blocks.push(
      { tag: 'markdown', content: heading, text_size: 'heading' },
      ...(metaLine ? [{ tag: 'markdown', content: metaLine, text_size: 'notation' }] : []),
    );
    // One session = one conversation: every hit block belongs to that session,
    // so no per-segment label is needed.
    for (const g of c.groups) {
      blocks.push({ tag: 'markdown', content: renderSearchContext(g, 'compact', keyword) });
    }
    if (showButtons) {
      blocks.push(
        ...actions([
          { text: '查看详情', value: { cmd: 'search.show', arg: `${queryId} ${globalIdx + 1}` } },
          { text: '继续对话', value: { cmd: 'search.resume', arg: c.sessionId }, style: 'primary' },
        ]),
      );
    }
    const lastOfPage = i === shown.length - 1;
    if (!lastOfPage || (showButtons && (remaining > 0 || offset > 0))) {
      blocks.push({ tag: 'hr' });
    }
  });
  if (showButtons) {
    const pageButtons: ButtonSpec[] = [];
    if (offset > 0) {
      pageButtons.push({
        text: '↑ 上一页',
        value: { cmd: 'search.page', arg: `${queryId} ${Math.max(0, offset - SEARCH_PAGE_SIZE)}` },
      });
    }
    if (remaining > 0) {
      pageButtons.push({
        text: `↓ 下一页（剩 ${remaining}）`,
        value: { cmd: 'search.page', arg: `${queryId} ${offset + SEARCH_PAGE_SIZE}` },
      });
    }
    pageButtons.push({ text: '完成', value: { cmd: 'search.done', arg: queryId } });
    blocks.push(...actions(pageButtons));
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
  // Done state keeps the full header (number / workspace / work session) —
  // only the buttons are stripped. "✅" marks it as settled.
  const elements: object[] = [
    { tag: 'markdown', content: `✅ **${label}**`, text_size: 'heading' },
  ];
  const metaLine = [
    workspace ? `📁 ${escapeMd(workspace)}` : '',
    // Full id here: this is the one place the session can be identified
    // exactly (the list only carries an 8-char handle).
    sessionId ? `🆔 ${escapeMd(sessionId)}` : '',
  ]
    .filter(Boolean)
    .join(' · ');
  if (metaLine) elements.push({ tag: 'markdown', content: metaLine, text_size: 'notation' });
  elements.push({ tag: 'hr' }, { tag: 'markdown', content });
  if (!done) {
    elements.push(
      { tag: 'hr' },
      ...actions([
        { text: '继续对话', value: { cmd: 'search.resume', arg: sessionId ?? '' }, style: 'primary' },
        { text: '完成', value: { cmd: 'search.done', arg: queryRef ?? '' } },
      ]),
    );
  }
  return {
    schema: '2.0',
    config: { summary: { content: '搜索详情' } },
    body: { elements },
  };
}
