import { beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import { EXPIRED_INTERACTION_TEXT, cardSettlesFlushed, formatIdleLine, updateOrFallback, withExpiryNotice } from './shared';

vi.mock('../card/managed', async (orig) => {
  const actual = await orig<typeof import('../card/managed')>();
  return { ...actual, sendManagedCard: vi.fn(async () => undefined), updateManagedCard: vi.fn() };
});
import { sendManagedCard, updateManagedCard } from '../card/managed';
import { codeSpan, summarize, summarizeMd } from '../utils/text';
import type { RunCard } from '../card/run-renderer';

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

describe('withExpiryNotice', () => {
  it('appends one expiry line and keeps every element of the original card', () => {
    const card: RunCard = {
      schema: '2.0',
      config: { summary: { content: 'OMP 交互已处理' } },
      body: { elements: [{ tag: 'markdown', content: '✅ 已提交给 OMP。' }] },
    };
    expect(withExpiryNotice(card)).toEqual({
      schema: '2.0',
      config: { summary: { content: 'OMP 交互已处理' } },
      body: {
        elements: [
          { tag: 'markdown', content: '✅ 已提交给 OMP。' },
          { tag: 'markdown', content: `_${EXPIRED_INTERACTION_TEXT}_` },
        ],
      },
    });
  });

  it('leaves a shape it cannot extend untouched', () => {
    const notACard = { schema: '2.0', body: {} };
    expect(withExpiryNotice(notACard)).toBe(notACard);
  });
});

describe('formatIdleLine', () => {
  it('prefers the scope override', () => {
    expect(formatIdleLine(15, 30)).toBe('本会话 15 分钟');
  });

  it('labels an explicit scope off as closed', () => {
    expect(formatIdleLine(0, 30)).toBe('本会话已关闭');
  });

  it('falls back to the global default', () => {
    expect(formatIdleLine(undefined, 30)).toBe('全局 30 分钟');
  });

  it('says disabled when nothing is configured', () => {
    expect(formatIdleLine(undefined, 0)).toBe('未启用（不自动中断任务）');
  });
});

describe('updateOrFallback：卡片不在托管表里时的补救', () => {
  const card = { schema: '2.0', body: { elements: [{ tag: 'markdown', content: '终态' }] } };
  const makeCtx = (opts: { patchFails?: boolean } = {}): never =>
    ({
      msg: { chatId: 'oc_1', messageId: 'om_old' },
      channel: {
        rawClient: {
          im: {
            v1: {
              message: {
                patch: opts.patchFails
                  ? vi.fn(async () => {
                      throw new Error('patch rejected');
                    })
                  : vi.fn(async () => ({})),
              },
            },
          },
        },
        send: vi.fn(async () => ({ messageId: 'om_new' })),
      },
      chatMode: 'p2p',
    }) as never;

  beforeEach(() => {
    vi.mocked(sendManagedCard).mockClear();
    vi.mocked(updateManagedCard).mockReset();
    vi.mocked(updateManagedCard).mockRejectedValue(
      new Error('no managed card registered for message om_old'),
    );
  });

  it('不在托管表：把消息内容整体替换成新卡片（对流式/裸 JSON 内容有效）', async () => {
    const c = makeCtx();
    await updateOrFallback(c, card, '兜底文案');
    await cardSettlesFlushed();
    const patch = (c as unknown as { channel: { rawClient: { im: { v1: { message: { patch: Mock } } } } } })
      .channel.rawClient.im.v1.message.patch;
    expect(patch).toHaveBeenCalledTimes(1);
    expect((patch.mock.calls[0]![0] as { data: { content: string } }).data.content).toContain('终态');
    expect(vi.mocked(sendManagedCard)).not.toHaveBeenCalled();
  });

  it('raw patch 也失败：退回一条可见回复（绝不静默）', async () => {
    const c = makeCtx({ patchFails: true });
    await updateOrFallback(c, card, '请重新发送 `/history` 查看会话列表。');
    await cardSettlesFlushed();
    const sent = (c as unknown as { channel: { send: Mock } }).channel.send;
    expect(sent).toHaveBeenCalled();
  });

  it('resendWhenUnmanaged（列表/分页/选择器）：托管更新失败直接补发新卡', async () => {
    const c = makeCtx();
    vi.mocked(sendManagedCard).mockResolvedValueOnce({ messageId: 'om_new' } as never);
    await updateOrFallback(c, card, '兜底文案', { keepManaged: true, resendWhenUnmanaged: true });
    await cardSettlesFlushed();
    expect(vi.mocked(sendManagedCard)).toHaveBeenCalledTimes(1);
  });
});
