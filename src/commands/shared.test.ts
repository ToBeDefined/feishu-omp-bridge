import { describe, expect, it } from 'vitest';
import { codeSpan, formatAgo, summarize, summarizeMd } from './shared';

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

describe('summarize', () => {
  it('returns empty for empty input', () => {
    expect(summarize('')).toBe('');
  });

  it('collapses whitespace', () => {
    expect(summarize('a   b\n\tc')).toBe('a b c');
  });

  it('keeps short text unchanged', () => {
    expect(summarize('short')).toBe('short');
  });

  it('truncates at max with ellipsis', () => {
    expect(summarize('x'.repeat(100), 48)).toBe('x'.repeat(48) + '…');
    expect(summarize('x'.repeat(48), 48)).toBe('x'.repeat(48));
  });

  it('truncates at custom max', () => {
    expect(summarize('hello world', 5)).toBe('hello…');
  });

  it('handles only-whitespace input', () => {
    expect(summarize('   \n  ')).toBe('');
  });
});

describe('summarizeMd', () => {
  it('escapes markdown metacharacters so user text cannot break the card', () => {
    expect(summarizeMd('a *bold* _em_ `code`', 100)).toBe(
      'a \\*bold\\* \\_em\\_ \\`code\\`',
    );
  });

  it('never leaves an escape sequence half-cut at the truncation point', () => {
    const out = summarizeMd('*'.repeat(100), 48);
    // Truncate on raw text first, then escape: 48 raw stars become 48
    // escaped stars, not a stray trailing backslash.
    expect(out.endsWith('\\*…')).toBe(true);
    expect(out.startsWith('\\*')).toBe(true);
  });
});

describe('codeSpan', () => {
  it('replaces backticks so a code span cannot be closed early', () => {
    expect(codeSpan('ls `pwd`')).toBe("ls 'pwd'");
  });

  it('passes through clean values unchanged', () => {
    expect(codeSpan('hello world')).toBe('hello world');
  });
});
