import { describe, expect, it } from 'vitest';
import type { NormalizedMessage } from '@larksuiteoapi/node-sdk';
import type { LocalAttachment } from '../media/cache';
import type { QuotedContext } from './quote';
import { buildPrompt, buildBridgeContextHeader, expandedMessageContent } from './prompt';

function msg(partial: Partial<NormalizedMessage> = {}): NormalizedMessage {
  return {
    messageId: 'om_1',
    chatId: 'oc_1',
    chatType: 'p2p',
    content: 'hello',
    rawContentType: 'text',
    resources: [],
    mentions: [],
    mentionAll: false,
    mentionedBot: false,
    senderId: 'ou_1',
    senderName: 'tester',
    createTime: 0,
    ...partial,
  } as NormalizedMessage;
}

describe('buildPrompt', () => {
  it('prefixes bridge context header', () => {
    const prompt = buildPrompt([msg()], []);
    expect(prompt).toContain('<bridge_context>');
    expect(prompt).toContain('chat_id: oc_1');
    expect(prompt).toContain('hello');
  });

  it('joins multiple messages with blank lines', () => {
    const prompt = buildPrompt([msg({ content: 'first' }), msg({ content: 'second' })], []);
    expect(prompt).toContain('first');
    expect(prompt).toContain('second');
  });

  it('lists attachment paths when present', () => {
    const attachments: LocalAttachment[] = [
      { path: '/tmp/a.png', kind: 'image', originalName: 'a.png' },
      { path: '/tmp/b.pdf', kind: 'file', originalName: 'b.pdf' },
    ];
    const prompt = buildPrompt([msg({ content: '' })], attachments);
    expect(prompt).toContain('附件（本地路径）');
    expect(prompt).toContain('/tmp/a.png (a.png) — 图片');
    expect(prompt).toContain('/tmp/b.pdf (b.pdf) — 文件');
  });

  it('inlines extracted text-file content instead of only a path', () => {
    const attachments: LocalAttachment[] = [
      { path: '/tmp/notes.md', kind: 'file', originalName: 'notes.md', content: 'hello from file' },
    ];
    const prompt = buildPrompt([msg({ content: '' })], attachments);
    expect(prompt).toContain('内容：');
    expect(prompt).toContain('hello from file');
    expect(prompt).toContain('```');
  });

  it('does not inline text content for non-file kinds', () => {
    const attachments: LocalAttachment[] = [
      { path: '/tmp/voice.ogg', kind: 'audio', transcript: '转写文本' },
    ];
    const prompt = buildPrompt([msg({ content: '' })], attachments);
    expect(prompt).not.toContain('内容：');
  });

  it('renders quoted block between context and user text', () => {    const quotes: QuotedContext[] = [
      { messageId: 'om_q', senderId: 'ou_1', createdAt: '', content: 'quoted text', rawContentType: 'text' },
    ];
    const prompt = buildPrompt([msg({ content: 'reply' })], [], quotes);
    const ctxIdx = prompt.indexOf('<bridge_context>');
    const quoteIdx = prompt.indexOf('quoted text');
    const replyIdx = prompt.indexOf('reply');
    expect(ctxIdx).toBeLessThan(quoteIdx);
    expect(quoteIdx).toBeLessThan(replyIdx);
  });

  it('renders voice transcript inline for audio attachments', () => {
    const attachments: LocalAttachment[] = [
      { path: '/tmp/voice.ogg', kind: 'audio', transcript: '帮我查下明天的天气' },
    ];
    const prompt = buildPrompt([msg({ content: '' })], attachments);
    expect(prompt).toContain('/tmp/voice.ogg — 语音');
    expect(prompt).toContain('转写: 帮我查下明天的天气');
  });

  it('renders transcript inline for video attachments', () => {
    const attachments: LocalAttachment[] = [
      { path: '/tmp/clip.mp4', kind: 'video', transcript: '这是演示视频的内容' },
    ];
    const prompt = buildPrompt([msg({ content: '' })], attachments);
    expect(prompt).toContain('/tmp/clip.mp4 — 视频');
    expect(prompt).toContain('转写: 这是演示视频的内容');
  });
});

describe('buildBridgeContextHeader', () => {
  it('includes thread id when present', () => {
    const header = buildBridgeContextHeader([msg({ threadId: 'omt_1' })]);
    expect(header).toContain('thread_id: omt_1');
  });

  it('returns empty string for empty batch', () => {
    expect(buildBridgeContextHeader([])).toBe('');
  });
});

describe('expandedMessageContent', () => {
  it('passes through non-interactive content untouched', () => {
    expect(expandedMessageContent(msg({ content: 'plain', rawContentType: 'text' }))).toBe('plain');
  });
});
