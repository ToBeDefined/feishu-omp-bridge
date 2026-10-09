import { describe, expect, it } from 'vitest';
import { codeSpan, summarize, summarizeMd } from './shared';

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
