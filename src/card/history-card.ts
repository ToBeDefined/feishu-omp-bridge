import { actions, shortPath } from './templates';
import { escapeMd, summarizeMd } from '../utils/text';
import { formatAgo, formatClock } from '../utils/time';

/**
 * /history card — a read-only ledger of past conversations.
 *
 * Deliberately NOT resumeCard: that one is a picker (per-row 恢复 button,
 * "当前" marker, cross-chat ownership rules) whereas this is a record — when
 * the conversation happened, how long it ran, and where. Restoring stays
 * /resume's job, so the two cannot drift into each other.
 *
 * Takes plain rows (no CommandContext) like every other card in this layer:
 * the command resolves workspace labels before calling in.
 */

/** Rows per page. 8 rows × 2-3 elements stays well under the card's
 * element/size budget even with titles plus digests on every row. */
export const HISTORY_PAGE_SIZE = 8;

export interface HistoryRow {
  sessionId: string;
  /** Last activity (ms epoch) — the sort key and the displayed time. */
  updatedAtMs: number;
  /** Real user turns in the session. */
  turns: number;
  /** Workspace label (named workspace or collapsed path). Only rendered in
   * 'all' mode, where a page mixes directories. */
  workspace: string;
  /** User-assigned title (/rename). */
  title?: string;
  /** What the conversation was about — the last real user message. */
  topic?: string;
}

export interface HistoryPage {
  /** 'cwd' = only the current workspace; 'all' = every workspace. */
  mode: 'cwd' | 'all';
  /** Current workspace, shown in the header for 'cwd' mode. */
  cwd?: string;
  offset: number;
  total: number;
}

export function historyCard(rows: HistoryRow[], opts: HistoryPage): object {
  const page = rows.slice(opts.offset, opts.offset + HISTORY_PAGE_SIZE);
  const remaining = opts.total - (opts.offset + page.length);
  const range =
    opts.total > page.length ? ` · 第 ${opts.offset + 1}-${opts.offset + page.length} 个` : '';
  const head =
    opts.mode === 'all'
      ? `全部工作区 · ${opts.total} 个会话${range}`
      : `\`${shortPath(opts.cwd ?? '')}\` · ${opts.total} 个会话${range}`;

  const elements: object[] = [
    { tag: 'markdown', content: '🕘 **对话历史**', text_size: 'heading' },
    { tag: 'markdown', content: head, text_size: 'notation' },
    { tag: 'hr' },
  ];

  page.forEach((row, i) => {
    // Identity: the name you gave it, else what the conversation was about.
    const identity = row.title
      ? `🏷 **${escapeMd(row.title)}**`
      : row.topic
        ? `**${summarizeMd(row.topic, 24)}**`
        : '_未命名会话_';
    elements.push({ tag: 'markdown', content: `**#${opts.offset + i + 1}** ${identity}` });

    const meta = [
      `🕘 ${formatClock(row.updatedAtMs)} · ${formatAgo(Date.now() - row.updatedAtMs)}`,
      `💬 ${row.turns} 轮`,
      // Every 'cwd'-mode row shares the header's directory — repeating it per
      // row would be noise.
      ...(opts.mode === 'all' ? [`📁 ${escapeMd(row.workspace)}`] : []),
      `🆔 ${row.sessionId.slice(0, 8)}…`,
    ];
    elements.push({ tag: 'markdown', content: meta.join(' · '), text_size: 'notation' });

    // A named session still gets one detail line, so the title does not hide
    // what the conversation contained.
    if (row.title && row.topic) {
      elements.push({
        tag: 'markdown',
        content: `💬 ${summarizeMd(row.topic, 48)}`,
        text_size: 'notation',
      });
    }
    if (i < page.length - 1) elements.push({ tag: 'hr' });
  });

  const pager: Array<{ text: string; value: Record<string, unknown> }> = [];
  if (opts.offset > 0) {
    pager.push({
      text: '↑ 较新的',
      value: {
        cmd: 'history.page',
        arg: `${opts.mode} ${Math.max(0, opts.offset - HISTORY_PAGE_SIZE)}`,
      },
    });
  }
  if (remaining > 0) {
    pager.push({
      text: `↓ 更早（剩 ${remaining}）`,
      value: { cmd: 'history.page', arg: `${opts.mode} ${opts.offset + HISTORY_PAGE_SIZE}` },
    });
  }
  // Shared action-row layout (each button on its own full-width row).
  if (pager.length > 0) elements.push(...actions(pager));
  elements.push({
    tag: 'markdown',
    content: '_只读清单；要接着聊用 `/resume`，检索内容用 `/search`。_',
    text_size: 'notation',
  });

  return {
    schema: '2.0',
    config: { summary: { content: `对话历史 ${opts.total} 个会话` } },
    body: { elements },
  };
}
