import { inlineActions, panel, shortPath, stackedPanels } from './templates';
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
  /** OMP session id — one session = one conversation, so this is both the
   * row's identity and the 继续对话 payload. */
  sessionId: string;
  /** Last activity (ms epoch) — the sort key and the displayed time. */
  updatedAtMs: number;
  /** Σ real user turns in the session. */
  turns: number;
  /** Workspace label (named workspace or collapsed path). Only rendered in
   * 'all' mode, where a page mixes directories. */
  workspace: string;
  /** User-assigned title (/rename). */
  title?: string;
  /** What the conversation was about — the last user message. */
  topic?: string;
}

/** The scope's CURRENT session — its row is marked instead of offering a
 * resume that would be a no-op. */
export interface HistoryPage {
  /** 'cwd' = only the current workspace; 'all' = every workspace. */
  mode: 'cwd' | 'all';
  /** Current workspace, shown in the header for 'cwd' mode. */
  cwd?: string;
  offset: number;
  total: number;
  /** OMP session id the calling scope is already on, if any. */
  currentSessionId?: string;
}

export function historyCard(rows: HistoryRow[], opts: HistoryPage): object {
  const page = rows.slice(opts.offset, opts.offset + HISTORY_PAGE_SIZE);
  const remaining = opts.total - (opts.offset + page.length);
  // A stale page button can point past the end; only print a span when a row is
  // actually on screen and the listing spans more than one page, otherwise an
  // out-of-range offset would render a REVERSED range ("第 9-8 个").
  const range =
    page.length > 0 && (opts.offset > 0 || remaining > 0)
      ? ` · 第 ${opts.offset + 1}-${opts.offset + page.length} 个`
      : '';
  const head =
    opts.mode === 'all'
      ? `全部工作区 · ${opts.total} 个会话${range} · 每页 ${HISTORY_PAGE_SIZE} 条`
      : `\`${shortPath(opts.cwd ?? '')}\` · ${opts.total} 个会话${range} · 每页 ${HISTORY_PAGE_SIZE} 条`;

  const elements: object[] = [
    { tag: 'markdown', content: '🕘 **对话历史**', text_size: 'heading' },
    { tag: 'markdown', content: head, text_size: 'notation' },
  ];
  // S10: a zero-row page (no sessions yet, or a stale page button) used to be a
  // dead end — a dangling hr + a mode button and nothing to act on. Give it a
  // real next step and skip the hr entirely.
  if (page.length === 0) {
    elements.push({
      tag: 'markdown',
      content: opts.total === 0 ? '_暂无历史会话。发条消息就开始一段新的。_' : '_没有更多了。_',
      text_size: 'notation',
    });
  } else {
    elements.push({ tag: 'hr' });
  }

  page.forEach((row, i) => {
    // Identity: the name you gave it, else what the conversation was about —
    // the last user message.
    const identity = row.title
      ? `🏷 **${escapeMd(row.title)}**`
      : row.topic
        ? `**${summarizeMd(row.topic, 24)}**`
        : '_未命名会话_';

    const isCurrent =
      opts.currentSessionId !== undefined && row.sessionId === opts.currentSessionId;
    const meta = [
      `🕘 ${formatClock(row.updatedAtMs)} · ${formatAgo(Date.now() - row.updatedAtMs)}`,
      `🔁 ${row.turns} 轮`,
      // Every 'cwd'-mode row shares the header's directory — repeating it per
      // row would be noise.
      ...(opts.mode === 'all' ? [`📁 ${escapeMd(row.workspace)}`] : []),
      `🔗 ${row.sessionId.slice(0, 8)}…`,
    ];

    // The current-session marker rides on the identity line — right behind the
    // row number, where it is actually noticed (it was buried in the meta line).
    const lines: object[] = [
      {
        tag: 'markdown',
        content: `**#${opts.offset + i + 1}**${isCurrent ? ' ⭐ 当前 ·' : ''} ${identity}`,
      },
      { tag: 'markdown', content: meta.join(' · '), text_size: 'notation' },
    ];
    // A named session still gets one detail line, so the title does not hide
    // what the conversation contained.
    if (row.title && row.topic) {
      lines.push({
        tag: 'markdown',
        content: `💬 ${summarizeMd(row.topic, 48)}`,
        text_size: 'notation',
      });
    }
    // Row layout: the identity / meta / topic lines sit in a grey block, and
    // the row's action goes side by side UNDER it — the same shape as a
    // /search result row, so the two list cards read alike.
    //
    // The only row action is 继续对话 — and even that is dropped on the current
    // row, where resuming would be a no-op (leaving just the block).
    elements.push(...stackedPanels([panel(lines)]));
    if (!isCurrent) {
      elements.push(
        ...inlineActions([
          {
            text: '继续对话',
            value: { cmd: 'history.resume', arg: row.sessionId },
            style: 'primary',
          },
        ]),
      );
    }
    if (i < page.length - 1) elements.push({ tag: 'hr' });
  });

  const pager: Array<{ text: string; value: Record<string, unknown> }> = [];
  if (opts.offset > 0) {
    pager.push({
      // 与 /search 同一套文案：两卡翻页读起来一样（此前是「较新的 / 更早」）。
      text: '↑ 上一页',
      value: {
        cmd: 'history.page',
        arg: `${opts.mode} ${Math.max(0, opts.offset - HISTORY_PAGE_SIZE)}`,
      },
    });
  }
  if (remaining > 0) {
    pager.push({
      text: `↓ 下一页（剩 ${remaining}）`,
      value: { cmd: 'history.page', arg: `${opts.mode} ${opts.offset + HISTORY_PAGE_SIZE}` },
    });
  }
  // 显式的工作区范围入口：默认只列当前目录，用户不看文档根本不知道有 `/history all`。
  // 复用 history.page 管线，切模式 = 回到该模式第 1 页。
  const modeToggle =
    opts.mode === 'all'
      ? { text: '📂 当前工作区', value: { cmd: 'history.page', arg: 'cwd 0' } }
      : { text: '🌐 全部工作区', value: { cmd: 'history.page', arg: 'all 0' } };
  // 分页按钮并排（规则 1）；长标签多分宽度。模式按钮跟在分页键后面，超出一行时
  // `inlineActions` 自动折行。
  const actions = [...pager, modeToggle];
  elements.push(
    ...inlineActions(actions.map((b) => (b.text.includes('下一页') ? { ...b, weight: 1.6 } : b))),
  );
  // The legend references the per-row 继续对话 button, which does not exist on
  // an empty page — printing it there would point at nothing.
  if (page.length > 0) {
    elements.push({
      tag: 'markdown',
      content: '_点「继续对话」接着聊（等同 `/resume <id>`），检索内容用 `/search`；跨工作区看用「全部工作区」。_',
      text_size: 'notation',
    });
  }

  return {
    schema: '2.0',
    config: { summary: { content: `对话历史 ${opts.total} 个会话` } },
    body: { elements },
  };
}
