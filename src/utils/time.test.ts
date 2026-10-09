import { describe, expect, it } from 'vitest';
import { formatAgo, formatClock } from './time';

describe('formatAgo', () => {
  it('renders seconds for sub-minute', () => {
    expect(formatAgo(0)).toBe('0 秒前');
    expect(formatAgo(1_000)).toBe('1 秒前');
    expect(formatAgo(59_000)).toBe('59 秒前');
  });

  it('renders minutes for sub-hour', () => {
    expect(formatAgo(60_000)).toBe('1 分钟前');
    expect(formatAgo(3_599_000)).toBe('59 分钟前');
  });

  it('renders hours for sub-day', () => {
    expect(formatAgo(3_600_000)).toBe('1 小时前');
    expect(formatAgo(86_399_000)).toBe('23 小时前');
  });

  it('renders days beyond a day', () => {
    expect(formatAgo(86_400_000)).toBe('1 天前');
    expect(formatAgo(7 * 86_400_000)).toBe('7 天前');
  });

  it('handles negative input as seconds', () => {
    expect(formatAgo(-5000)).toBe('-5 秒前');
  });

  it('drops sub-second precision', () => {
    expect(formatAgo(1_999)).toBe('1 秒前');
  });
});

describe('formatClock', () => {
  it('labels today with 今天 HH:mm', () => {
    const now = new Date();
    const ts = new Date(
      now.getFullYear(),
      now.getMonth(),
      now.getDate(),
      9,
      5,
    ).getTime();
    expect(formatClock(ts)).toBe('今天 09:05');
  });

  it('labels other days with M月D日 HH:mm', () => {
    const now = new Date();
    const yest = new Date(
      now.getFullYear(),
      now.getMonth(),
      now.getDate() - 1,
      14,
      30,
    );
    expect(formatClock(yest.getTime())).toBe(
      `${yest.getMonth() + 1}月${yest.getDate()}日 14:30`,
    );
  });
});
