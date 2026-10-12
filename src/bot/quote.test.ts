import { describe, expect, it } from 'vitest';
import { parseMessageContent, renderQuotedBlock, type QuotedContext } from './quote';

function q(over: Partial<QuotedContext> = {}): QuotedContext {
  return {
    messageId: 'om_1',
    senderId: 'ou_1',
    senderName: 'alice',
    createdAt: '2026-08-17T00:00:00.000Z',
    content: 'hello',
    rawContentType: 'text',
    ...over,
  };
}

describe('renderQuotedBlock', () => {
  it('returns empty for no quotes', () => {
    expect(renderQuotedBlock([])).toBe('');
  });

  it('renders one quoted message with attrs', () => {
    const out = renderQuotedBlock([q()]);
    expect(out).toContain('<quoted_message id="om_1"');
    expect(out).toContain('sender_name="alice"');
    expect(out).toContain('hello');
    expect(out).toContain('</quoted_message>');
  });

  it('joins multiple quotes', () => {
    const out = renderQuotedBlock([q(), q({ messageId: 'om_2', content: 'second' })]);
    expect(out).toContain('om_1');
    expect(out).toContain('om_2');
    expect(out).toContain('second');
  });

  it('caps an oversized quote with a truncation marker', () => {
    const big = 'x'.repeat(20_000);
    const out = renderQuotedBlock([q({ content: big })]);
    expect(out).toContain('（引用内容已截断）');
    // 8000 cap + marker
    expect(out).toContain('x'.repeat(8000));
    expect(out).not.toContain('x'.repeat(8001));
  });

  it('keeps content under the cap unchanged', () => {
    const small = 'y'.repeat(500);
    const out = renderQuotedBlock([q({ content: small })]);
    expect(out).toContain(small);
    expect(out).not.toContain('（引用内容已截断）');
  });
});

describe('parseMessageContent', () => {
  it('extracts text messages', () => {
    expect(parseMessageContent('text', JSON.stringify({ text: 'hello' }))).toBe('hello');
  });

  it('joins post blocks', () => {
    const post = JSON.stringify({
      content: [
        [{ tag: 'text', text: 'line1' }, { tag: 'text', text: 'line2' }],
        [{ tag: 'text', text: 'line3' }],
      ],
    });
    expect(parseMessageContent('post', post)).toBe('line1\nline2\nline3');
  });

  it('prefixes the post title and appends a-element links at the end', () => {
    const post = JSON.stringify({
      title: '发布计划',
      content: [
        [{ tag: 'a', href: 'https://example.com' }, { tag: 'text', text: '详见文档' }],
      ],
    });
    expect(parseMessageContent('post', post)).toBe(
      '【发布计划】\n详见文档\nhttps://example.com',
    );
  });

  it('renders a link-only post without dropping it to empty', () => {
    const post = JSON.stringify({
      content: [[{ tag: 'a', href: 'https://example.com/x' }]],
    });
    const out = parseMessageContent('post', post);
    expect(out).toBe('https://example.com/x');
  });

  it('falls back to a non-empty marker for an empty post', () => {
    expect(parseMessageContent('post', JSON.stringify({ content: [] }))).toBe(
      '[富文本/链接卡片]',
    );
    expect(parseMessageContent('post', JSON.stringify({ title: 't', content: [] }))).toBe(
      '【t】',
    );
  });

  it('falls back to a type marker for other types', () => {
    expect(parseMessageContent('image', JSON.stringify({ image_key: 'img_1' }))).toContain('[image]');
  });

  it('returns empty for empty content', () => {
    expect(parseMessageContent('text', '')).toBe('');
  });
});
