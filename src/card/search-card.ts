import { codeSpan, escapeMd, summarizeMd } from '../utils/text';
import { formatAgoOr } from '../utils/time';
import {
  inlineActions,
  md,
  panel,
  shortSessionId,
  stackedPanels,
  type ButtonSpec,
} from './templates';

/**
 * Search result card rendering.
 *
 * Three rules drive the layout:
 * - **The snippet is centred on the keyword**, not on the head of the message.
 *   A keyword match 2 000 characters into an answer used to render a prefix
 *   with no visible hit at all — the one thing a search result must show.
 * - **A row is a vertical stack**: identity, meta, one grey block per matched
 *   pair, then its two actions side by side at the bottom. A right-hand button
 *   column made the buttons float next to the first line; at the bottom they
 *   belong to the whole row and are a bigger tap target. The pager and the
 *   detail card's footer use the same side-by-side row, so every action pair in
 *   these cards is horizontal — no stacked full-width button.
 * - **Matched content sits in a grey block** (`panel`/`stackedPanels`, the same
 *   rounded block /context and the run card use): it is the payload of the row,
 *   and the block's edges delimit rows better than a divider line between two
 *   lines of small grey type.
 * - **Only the card title is heading-sized.** Six heading-sized rows of
 *   identity text is unreadable on a phone; row identity is default-size bold
 *   and everything else is `notation` (the /history card's idiom).
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
  /** Matched pairs per source group, newest first. */
  groups: SearchHitGroup[];
  /** Newest group's pair — the list row's first snippet. */
  messages: SearchHit[];
  hitIndex: number;
}

/** Snippet budget (characters) per compact row line. The assistant gets more
 * room than the (usually shorter) question. */
const COMPACT_USER_CHARS = 56;
const COMPACT_ASSISTANT_CHARS = 88;
/** Detail-view budgets — long enough to read the answer, still bounded so a
 * 3 000-character dump cannot take over the card. */
const DETAIL_USER_CHARS = 600;
const DETAIL_ASSISTANT_CHARS = 1000;
/** Matched pairs rendered per row in the list; the rest are behind 详情. */
export const SEARCH_COMPACT_GROUPS = 2;

/** Escape every regex metacharacter, so the keyword is matched literally.
 * `escapeMd` alone is not enough: `.` `+` `|` `?` `^` `$` `{` `}` are markdown
 * literals it leaves alone, and they would act as pattern syntax here —
 * `/search 1.5` used to bold `125` and `/search a|b` used to bold `a`/`b`. */
function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Wrap keyword occurrences (case-insensitive) in bold — applied AFTER
 * markdown escaping so both sides share the same escaped form.
 */
function highlightKeyword(escapedText: string, keyword: string | undefined): string {
  if (!keyword) return escapedText;
  const pattern = escapeRegExp(escapeMd(keyword));
  if (!pattern) return escapedText;
  return escapedText.replace(new RegExp(pattern, 'gi'), (m) => `**${m}**`);
}

/**
 * Excerpt centred on the FIRST keyword hit, `…` marking each trimmed side.
 * Whitespace is collapsed, so the result is a single display line; without a
 * hit (or without a keyword) it degrades to the head of the text.
 */
export function excerptAround(text: string, keyword: string | undefined, budget: number): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  if (flat.length <= budget) return flat;
  const needle = keyword?.toLowerCase() ?? '';
  const at = needle ? flat.toLowerCase().indexOf(needle) : -1;
  if (at < 0) return `${flat.slice(0, budget)}…`;
  // Leave roughly a third of the budget before the hit: enough to recognise
  // the sentence, without pushing the hit out of sight on the right.
  let start = Math.max(0, at - Math.floor(budget / 3));
  let end = Math.min(flat.length, start + budget);
  const hitEnd = at + needle.length;
  if (hitEnd > end) {
    end = Math.min(flat.length, hitEnd);
    start = Math.max(0, end - budget);
  }
  return `${start > 0 ? '…' : ''}${flat.slice(start, end)}${end < flat.length ? '…' : ''}`;
}

/** Detail excerpt: same centring, but the message's own line breaks survive. */
function detailExcerpt(text: string, keyword: string | undefined, budget: number): string {
  const raw = text.trim();
  if (raw.length <= budget) return raw;
  const needle = keyword?.toLowerCase() ?? '';
  const at = needle ? raw.toLowerCase().indexOf(needle) : -1;
  const start = at < 0 ? 0 : Math.max(0, at - Math.floor(budget * 0.4));
  const end = Math.min(raw.length, start + budget);
  return [
    start > 0 ? '…' : '',
    raw.slice(start, end),
    end < raw.length ? '…' : '',
  ]
    .filter((part) => part !== '')
    .join('\n');
}

/**
 * Neutralise untrusted message content before embedding into card markdown:
 * `escapeMd` kills inline markdown (incl. `[x](url)` / `![](url)` links and
 * images), then line-leading `#` / `>` are escaped so the excerpt can't turn
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

/**
 * One matched pair.
 *
 * - `compact` → one line per message (`🧑 …` / `🤖 …`), for list rows: a pair
 *   costs 2 lines instead of 4-5.
 * - `detail` → role label on its own line, content as a block quote, so a long
 *   answer stays readable and every line of it is quoted.
 */
export function renderSearchContext(
  context: { messages: SearchHit[]; hitIndex: number },
  mode: 'compact' | 'detail' = 'compact',
  keyword?: string,
): string {
  return context.messages
    .map((m, i) => {
      const hit = i === context.hitIndex;
      const raw =
        mode === 'detail'
          ? detailExcerpt(
              m.content,
              keyword,
              m.role === 'user' ? DETAIL_USER_CHARS : DETAIL_ASSISTANT_CHARS,
            )
          : excerptAround(
              m.content,
              keyword,
              m.role === 'user' ? COMPACT_USER_CHARS : COMPACT_ASSISTANT_CHARS,
            );
      const body = highlightKeyword(escapeSearchContent(raw), keyword);
      if (mode === 'compact') {
        // 📍 marks the message that actually matched; the bold keyword shows
        // where. Both, because either one alone is easy to miss on a phone.
        const who = m.role === 'user' ? '🧑' : '🤖';
        return `${hit ? '📍' : ''}${who} ${body}`;
      }
      const who = m.role === 'user' ? '🧑 **你**' : '🤖 **助手**';
      const quoted = body
        .split('\n')
        .map((line) => `> ${line}`)
        .join('\n');
      return `${hit ? '📍' : ''}${who}\n${quoted}`;
    })
    .join(mode === 'detail' ? '\n\n' : '\n');
}

/**
 * One matched pair as a grey block, preceded by its `第 k 处` label when the
 * conversation matched more than once. The result list and the detail view
 * both go through here: the list simply renders fewer pairs and shorter
 * excerpts, so the two cards cannot drift into different looks.
 */
function pairBlocks(
  groups: SearchHitGroup[],
  mode: 'compact' | 'detail',
  keyword: string | undefined,
  labelled: boolean,
): object[] {
  const out: object[] = [];
  groups.forEach((g, i) => {
    if (labelled) out.push(md(`**第 ${i + 1} 处**`));
    const body = md(renderSearchContext(g, mode, keyword));
    // Empty groups cannot happen (a group exists because it matched), but an
    // empty block would render as a stray grey box.
    out.push(...greyBlock([body]));
  });
  return out;
}

/**
 * Every matched pair of one conversation, newest first. Multiple pairs get
 * `第 k 处` labels so the detail view is navigable when a conversation matched
 * several times; a single pair stays unlabelled (the label would be noise).
 */
export function renderSearchGroups(
  context: Pick<SearchContext, 'groups'>,
  mode: 'compact' | 'detail' = 'detail',
  keyword?: string,
): string {
  const multi = context.groups.length > 1;
  return context.groups
    .map((g, i) =>
      [
        multi ? `**第 ${i + 1} 处**` : '',
        renderSearchContext(g, mode, keyword),
      ]
        .filter(Boolean)
        .join('\n'),
    )
    .join(mode === 'detail' ? '\n\n' : '\n');
}

/** Newest timestamp across every matched pair, for the relative-time meta. */
function lastHitTime(context: SearchContext): number | undefined {
  const stamps = context.groups
    .flatMap((g) => g.messages)
    .concat(context.messages)
    .map((m) => m.timestamp)
    .filter((t): t is string => Boolean(t))
    .map((t) => Date.parse(t))
    .filter((n) => Number.isFinite(n));
  return stamps.length > 0 ? Math.max(...stamps) : undefined;
}

/** Row identity: the name you gave it, else what it was about; never an
 * invented title, and never a 36-character id in the oversized line. */
function rowIdentity(ctx: SearchContext): string {
  if (ctx.title) return `🏷 **${escapeMd(ctx.title)}**`;
  if (ctx.topic) return `**${summarizeMd(ctx.topic, 24)}**`;
  return '_未命名会话_';
}

export const SEARCH_PAGE_SIZE = 6;

export interface SearchResultsOpts {
  /** OMP session id the calling scope is already on: that row is marked
   * 「✅ 当前」 and drops its 继续对话 button (resuming it is a no-op) —
   * the same rule /history applies to its current row. */
  currentSessionId?: string;
}

export function searchResultsCard(
  keyword: string,
  contexts: SearchContext[],
  queryId: string,
  offset = 0,
  opts: SearchResultsOpts = {},
): object {
  const shown = contexts.slice(offset, offset + SEARCH_PAGE_SIZE);
  const remaining = contexts.length - (offset + shown.length);
  const totalMatches = contexts.reduce((n, c) => n + c.matchCount, 0);
  const range =
    shown.length > 0 && (offset > 0 || remaining > 0)
      ? ` · 第 ${offset + 1}-${offset + shown.length} 个`
      : '';
  // Only the card title is heading-sized; everything else stays small so six
  // rows fit on a phone screen without half a page of oversized type.
  const elements: object[] = [
    md(`🔍 **搜索** \`${codeSpan(keyword)}\``, 'heading'),
    md(`找到 ${contexts.length} 个对话 · ${totalMatches} 处匹配${range}`, 'notation'),
    { tag: 'hr' },
  ];
  // Pager buttons, built before the rows so the last row knows whether a
  // divider is needed below it.
  const pageButtons: Array<{ text: string; value: Record<string, unknown>; weight?: number }> = [];
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
      // 长标签多分宽度，否则等宽三等分会在手机上折行。
      weight: 1.6,
    });
  }

  shown.forEach((c, i) => {
    const globalIdx = offset + i;
    const ago = formatAgoOr(lastHitTime(c), '');
    const isCurrent =
      opts.currentSessionId !== undefined && c.sessionId === opts.currentSessionId;
    const lines: object[] = [
      // 当前对话的标记紧跟在行号后面 —— 埋在 meta 行里就没人看得见。
      md(`**#${globalIdx + 1}**${isCurrent ? ' ✅ 当前 ·' : ' ·'} ${rowIdentity(c)}`),
      md(
        [
          c.workspace ? `📁 ${escapeMd(c.workspace)}` : '',
          ago ? `🕘 ${ago}` : '',
          c.matchCount > 1 ? `🔎 ${c.matchCount} 处匹配` : '',
          // Identity handle: enough to tell rows apart. The full id is in 详情.
          `🆔 ${shortSessionId(c.sessionId)}`,
        ]
          .filter(Boolean)
          .join(' · '),
        'notation',
      ),
    ];
    // One session = one conversation: a row renders its newest matched pairs,
    // each as its own grey block (same block style as the detail view), and
    // keeps the rest behind 详情 (dumping every pair made rows unbounded).
    const visible = c.groups.slice(0, SEARCH_COMPACT_GROUPS);
    const hidden = c.groups.length - visible.length;

    // Identity + meta stay plain; every matched pair drops into its own grey
    // block, and the row's two actions sit side by side UNDER the blocks —
    // they act on the whole row, not on its first line.
    elements.push(...lines, ...pairBlocks(visible, 'compact', keyword, c.matchCount > 1));
    if (hidden > 0) {
      elements.push(md(`_另有 ${hidden} 处匹配，点「详情」看全部_`, 'notation'));
    }
    elements.push(
      ...inlineActions([
        // 当前对话不给「继续对话」：恢复它等于原地重启一次会话。
        ...(isCurrent
          ? []
          : [
              {
                text: '继续对话',
                value: { cmd: 'search.resume', arg: c.sessionId },
                style: 'primary' as const,
              },
            ]),
        { text: '详情', value: { cmd: 'search.show', arg: `${queryId} ${globalIdx + 1}` } },
      ]),
    );
    // One divider per row boundary — after every row that has something below
    // it (the next row, or the pager). Two rows in a row are dense blocks of
    // small grey type; the line is what makes the seam visible.
    if (i < shown.length - 1 || pageButtons.length > 0) elements.push({ tag: 'hr' });
  });

  // The divider before the pager is the one the last row already pushed (it
  // follows that row's own button pair — without it the pager would read as
  // that row's third action). Side by side like the row buttons.
  if (pageButtons.length > 0) elements.push(...inlineActions(pageButtons));
  return {
    schema: '2.0',
    config: { summary: { content: '搜索结果' } },
    body: { elements },
  };
}

/**
 * Rounded grey block holding the matched content — the row's payload, visually
 * separated from its small grey identity/meta lines. `panel()` produces a
 * `column`, which is only accepted inside a `column_set` (`stackedPanels`), and
 * an empty block would render as an empty box.
 */
function greyBlock(lines: object[]): object[] {
  return lines.length > 0 ? stackedPanels([panel(lines)]) : [];
}

/** Empty-hit card: friendlier than a bare text reply. */
export function searchEmptyCard(keyword: string): object {
  return {
    schema: '2.0',
    config: { summary: { content: '未找到匹配消息' } },
    body: {
      elements: [
        md(`🔍 没有找到包含 \`${codeSpan(keyword)}\` 的消息。`),
        md('_换个关键词，或缩短关键词再试。历史里的每条消息（含助手回答）都会被检索。_', 'notation'),
      ],
    },
  };
}

export interface SearchDetailInfo {
  /** OMP session id — shown in full: this is the one place it is exact. */
  sessionId: string;
  workspace?: string;
  /** 1-based row number in the result list. */
  index?: number;
  matchCount?: number;
  /** Every matched pair of the conversation, newest first. */
  groups: SearchHitGroup[];
  keyword?: string;
  /** `<queryId> <index>` — kept for the card's own bookkeeping. */
  queryRef?: string;
  /** This conversation is the scope's current one — marked, and its 继续对话
   * button (a no-op) is dropped. */
  current?: boolean;
}

export function searchDetailCard(info: SearchDetailInfo): object {
  const label = info.index !== undefined ? `搜索结果 #${info.index}` : '搜索详情';
  const elements: object[] = [md(`📄 **${label}**`, 'heading')];
  const metaLine = [
    info.current ? '✅ 当前对话' : '',
    info.workspace ? `📁 ${escapeMd(info.workspace)}` : '',
    info.matchCount !== undefined && info.matchCount > 1
      ? `🔎 ${info.matchCount} 处匹配`
      : '',
    // Full id here: this is the one place the session can be identified exactly
    // (the list only carries an 8-char handle).
    info.sessionId ? `🆔 ${escapeMd(info.sessionId)}` : '',
  ]
    .filter(Boolean)
    .join(' · ');
  if (metaLine) elements.push(md(metaLine, 'notation'));
  elements.push(
    { tag: 'hr' },
    ...pairBlocks(info.groups, 'detail', info.keyword, info.groups.length > 1),
  );
  // 当前对话没有可执行的动作（继续它等于原地重启），此时整个页脚都不渲染 ——
  // 不给一条光秃秃的分隔线收尾。
  if (!info.current) {
    elements.push(
      { tag: 'hr' },
      ...inlineActions([
        {
          text: '继续对话',
          value: { cmd: 'search.resume', arg: info.sessionId },
          style: 'primary' as const,
        },
      ]),
    );
  }
  return {
    schema: '2.0',
    config: { summary: { content: '搜索详情' } },
    body: { elements },
  };
}

/** Plain-text rendering of one conversation's hits, for the non-card reply
 * (`/search <kw>` typed outside a card flow). */
export function searchDetailText(info: SearchDetailInfo): string {
  const head = [
    info.workspace ? `📁 ${info.workspace}` : '',
    info.current ? '✅ 当前对话' : '',
  ]
    .filter(Boolean)
    .join(' · ');
  return `${head ? `${head}\n` : ''}🆔 会话: \`${codeSpan(info.sessionId)}\`\n\n${renderSearchGroups(info, 'detail', info.keyword)}`;
}
