import { actions, button, shortSessionId } from './templates';
import { escapeMd, summarizeMd } from '../utils/text';
import { formatAgo, formatClock } from '../utils/time';

/**
 * `/history seg <workSessionId>` card — the work session's segments, one row
 * per segment, each with a 恢复这一段 button.
 *
 * Unlike `historyCard` (one row per WORK session, 继续对话 restores that work
 * session's active segment), this is the drill-down: every segment is listed
 * and can be restored on its own, so a chat can go back to an earlier
 * conversation inside the same work.
 *
 * Takes plain rows (no CommandContext) like every other card in this layer:
 * the command resolves the work session and joins per-segment stats from its
 * ONE `scanSessionFiles` pass before calling in.
 */

export interface HistorySegmentRow {
  /** OMP session id (the segment). */
  sessionId: string;
  cwd: string;
  startedAtMs: number;
  /** Segment file's last write (ms epoch), else the store's last activity. */
  lastActiveAtMs: number;
  /** Real user turns — undefined when the segment's file is gone. */
  turns?: number;
  /** Last real user message — undefined when gone/empty. */
  lastMessage?: string;
}

export interface HistorySegList {
  /** Work session id (its first segment's OMP session id). */
  workSessionId: string;
  /** /rename name, if any. */
  title?: string;
  /** Fallback identity when unnamed: the active segment's last user message. */
  topic?: string;
  segments: HistorySegmentRow[];
  /** Segment the calling scope is already on — marked ✅. */
  currentSegmentId?: string;
}

export function historySegCard(list: HistorySegList): object {
  const identity = list.title
    ? `🏷 **${escapeMd(list.title)}**`
    : list.topic
      ? `**${summarizeMd(list.topic, 24)}**`
      : '_未命名工作会话_';

  const elements: object[] = [
    { tag: 'markdown', content: '🧵 **工作会话的段**', text_size: 'heading' },
    {
      tag: 'markdown',
      content: `\`${list.workSessionId}\` · 共 ${list.segments.length} 段`,
      text_size: 'notation',
    },
    { tag: 'markdown', content: identity, text_size: 'notation' },
    { tag: 'hr' },
  ];

  list.segments.forEach((seg, i) => {
    const isCurrent =
      list.currentSegmentId !== undefined && seg.sessionId === list.currentSegmentId;
    const meta = [
      `\`${shortSessionId(seg.sessionId)}\``,
      `📁 ${escapeMd(seg.cwd)}`,
      `🕒 ${formatClock(seg.startedAtMs)}`,
      `🕘 ${formatClock(seg.lastActiveAtMs)} · ${formatAgo(Date.now() - seg.lastActiveAtMs)}`,
      seg.turns !== undefined ? `💬 ${seg.turns} 轮` : '💬 文件缺失',
    ];
    const lines: object[] = [
      { tag: 'markdown', content: `**#${i + 1}**${isCurrent ? ' ✅ 当前' : ''}` },
      { tag: 'markdown', content: meta.join(' · '), text_size: 'notation' },
    ];
    if (seg.lastMessage) {
      lines.push({
        tag: 'markdown',
        content: `💬 ${summarizeMd(seg.lastMessage, 48)}`,
        text_size: 'notation',
      });
    }
    // Row layout mirrors historyCard: content in a weighted column, the
    // one-click 恢复这一段 button in an auto column.
    elements.push({
      tag: 'column_set',
      flex_mode: 'none',
      horizontal_spacing: 'small',
      columns: [
        { tag: 'column', width: 'weighted', weight: 1, vertical_align: 'center', elements: lines },
        {
          tag: 'column',
          width: 'auto',
          vertical_align: 'center',
          elements: [
            button({
              text: '恢复这一段',
              // Same cmd as the 继续对话 button: the dispatcher maps it to
              // `resume <id>`. Here the id IS a segment id, so the handler
              // restores EXACTLY that segment.
              value: { cmd: 'history.resume', arg: seg.sessionId },
              style: 'primary',
            }),
          ],
        },
      ],
    });
    if (i < list.segments.length - 1) elements.push({ tag: 'hr' });
  });

  // Back to the work-session ledger (payload → `page cwd 0`).
  elements.push(
    ...actions([{ text: '⬅️ 返回列表', value: { cmd: 'history.page', arg: 'cwd 0' } }]),
  );
  elements.push({
    tag: 'markdown',
    content: '_点「恢复这一段」把这条会话单独接回当前对话。_',
    text_size: 'notation',
  });

  return {
    schema: '2.0',
    config: { summary: { content: `工作会话 ${list.segments.length} 段` } },
    body: { elements },
  };
}
