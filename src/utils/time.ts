/**
 * Compact relative-time label (Chinese, matching CLI output style).
 * Negative input renders as negative seconds (clock skew tolerance).
 */
export function formatAgo(ms: number): string {
  if (ms < 60_000) return `${Math.floor(ms / 1000)} 秒前`;
  if (ms < 3_600_000) return `${Math.floor(ms / 60_000)} 分钟前`;
  if (ms < 86_400_000) return `${Math.floor(ms / 3_600_000)} 小时前`;
  return `${Math.floor(ms / 86_400_000)} 天前`;
}

/** Clock label: `今天 HH:mm` for today, `M月D日 HH:mm` otherwise. */
export function formatClock(ts: number): string {
  const d = new Date(ts);
  const today = new Date();
  const sameDay = d.toDateString() === today.toDateString();
  const hhmm = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  return sameDay ? `今天 ${hhmm}` : `${d.getMonth() + 1}月${d.getDate()}日 ${hhmm}`;
}

/** `formatAgo` with an explicit label for "never happened" (undefined ts). */
export function formatAgoOr(ts: number | undefined, fallback: string): string {
  return ts === undefined ? fallback : formatAgo(Date.now() - ts);
}

/** `formatClock` with an explicit label for "never happened" (undefined ts). */
export function formatClockOr(ts: number | undefined, fallback: string): string {
  return ts === undefined ? fallback : formatClock(ts);
}
