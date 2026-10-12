import { afterEach, describe, expect, it, vi } from 'vitest';
import { THINKING_FOLLOW_DEFAULT } from '../../card/model-card';
import type { CommandContext } from '../index';
import { modelHandlers } from './model';
import { saveConfig } from '../../config/store';
import { sendManagedCard, updateManagedCard } from '../../card/managed';
import { recentModels } from '../../session/model-history';
import { loadModelData } from './data';
import type * as DataModule from './data';

vi.mock('../../config/store', () => ({
  saveConfig: vi.fn(async () => {}),
}));

vi.mock('../../card/managed', () => ({
  sendManagedCard: vi.fn(async () => ({ messageId: 'om_card', cardId: 'card_1' })),
  updateManagedCard: vi.fn(async () => {}),
  forgetManagedCard: vi.fn(),
}));

// 保留真实实现（isChatModel 是真逻辑），只把取数换成 mock。
vi.mock('./data', async (importOriginal) => {
  const actual = await importOriginal<typeof DataModule>();
  return { ...actual, loadModelData: vi.fn() };
});

vi.mock('../../session/model-history', () => ({
  recentModels: vi.fn(async () => []),
}));

function makeCtx(overrides: {
  formValue?: Record<string, unknown>;
  ompModel?: string;
  ompThinking?: string;
} = {}): CommandContext {
  const send = vi.fn(async () => {});
  return {
    channel: { send },
    msg: { chatId: 'oc_1', messageId: 'om_1', content: '' },
    scope: 'oc_1',
    chatMode: 'p2p',
    workspaces: {},
    sessions: {},
    activeRuns: {},
    agent: {},
    formValue: overrides.formValue,
    controls: {
      configPath: '/tmp/feishu-omp-bridge-test-config.json',
      cfg: {
        preferences: {
          ompModel: overrides.ompModel,
          ompThinking: overrides.ompThinking,
        },
      },
    },
  } as unknown as CommandContext;
}

/** channel.send 收到的 markdown 文本（makeCtx 里 send 是 vi.fn）。 */
function sentMarkdown(ctx: CommandContext): string[] {
  const send: unknown = ctx.channel.send;
  if (typeof send !== 'function' || !('mock' in send)) return [];
  const calls = (send as { mock: { calls: unknown[][] } }).mock.calls;
  return calls.map((call) => {
    const payload = call[1];
    return typeof payload === 'object' && payload !== null && 'markdown' in payload &&
      typeof payload.markdown === 'string'
      ? payload.markdown
      : '';
  });
}

afterEach(() => {
  vi.mocked(saveConfig).mockClear();
  vi.mocked(sendManagedCard).mockClear();
  vi.mocked(recentModels).mockClear();
  vi.mocked(recentModels).mockResolvedValue([]);
});

describe('/model submit', () => {
  it('saves the selected model and thinking together', async () => {
    const ctx = makeCtx({
      ompThinking: 'low',
      formValue: { model_selector: 'p/a', thinking_level: 'high' },
    });
    await modelHandlers['/model']!('submit', ctx);
    expect(saveConfig).toHaveBeenCalledWith(
      expect.objectContaining({
        preferences: expect.objectContaining({ ompModel: 'p/a', ompThinking: 'high' }),
      }),
      '/tmp/feishu-omp-bridge-test-config.json',
    );
    expect(ctx.controls.cfg.preferences?.ompThinking).toBe('high');
    expect(ctx.controls.cfg.preferences?.ompModel).toBe('p/a');
  });

  it('clears thinking when the form asks to follow OMP default', async () => {
    const ctx = makeCtx({
      ompThinking: 'high',
      formValue: { model_selector: 'p/a', thinking_level: THINKING_FOLLOW_DEFAULT },
    });
    await modelHandlers['/model']!('submit', ctx);
    expect(ctx.controls.cfg.preferences?.ompThinking).toBeUndefined();
    expect(ctx.controls.cfg.preferences?.ompModel).toBe('p/a');
  });

  it('卡片收尾失败时回一句确认（不再静默吞掉）', async () => {
    // fromCardAction：保存成功后要原地把卡片改成「已保存」。卡片不在托管表里 +
    // 没有 rawClient 可 patch ⇒ 必须回一句「✅ 模型已设为 …」，而不是什么都没发生。
    const ctx = makeCtx({ formValue: { model_selector: 'p/a' } });
    (ctx as unknown as { fromCardAction: boolean }).fromCardAction = true;
    // 卡片不在本进程托管表里（重启前的老卡片）。
    vi.mocked(updateManagedCard).mockRejectedValueOnce(new Error('no managed card registered'));
    const send = ctx.channel.send as unknown as { mock: { calls: Array<[string, { markdown?: string }]> } };

    // 收尾链由 FORM_SETTLE_MS 的定时器驱动 → 用假时钟推进，不真等 1.3s。
    vi.useFakeTimers();
    await modelHandlers['/model']!('submit', ctx);
    await vi.advanceTimersByTimeAsync(1300);
    vi.useRealTimers();

    const texts = send.mock.calls.map((c) => c[1]?.markdown ?? '');
    expect(texts.some((t) => t.includes('模型已设为') && t.includes('p/a'))).toBe(true);
    expect(ctx.controls.cfg.preferences?.ompModel).toBe('p/a');
  });

  it('leaves thinking unchanged when the form has no thinking field', async () => {
    const ctx = makeCtx({
      ompThinking: 'medium',
      formValue: { model_selector: 'p/b' },
    });
    await modelHandlers['/model']!('submit', ctx);
    expect(ctx.controls.cfg.preferences?.ompThinking).toBe('medium');
    expect(ctx.controls.cfg.preferences?.ompModel).toBe('p/b');
  });

  it('says 未选择模型 instead of silently using the first option', async () => {
    // 跨提供方打开选择卡时不再预选（modelSelectCard）：没选就提交必须明确回绝。
    const ctx = makeCtx({ ompModel: 'futu/x', formValue: {} });
    await modelHandlers['/model']!('submit', ctx);
    expect(saveConfig).not.toHaveBeenCalled();
    expect(ctx.controls.cfg.preferences?.ompModel).toBe('futu/x');
    expect(sentMarkdown(ctx).some((t) => t.includes('未选择模型'))).toBe(true);
  });
});

describe('/model <selector> 逃生口', () => {
  it('sets a model that the picker filters out (直接指定仍可用)', async () => {
    const ctx = makeCtx({});
    // 非对话模型（text-embedding-*）不在选择器里，但用户明确指定时必须生效。
    await modelHandlers['/model']!('futu/text-embedding-3-large', ctx);
    expect(vi.mocked(saveConfig)).toHaveBeenCalledWith(
      expect.objectContaining({
        preferences: expect.objectContaining({ ompModel: 'futu/text-embedding-3-large' }),
      }),
      '/tmp/feishu-omp-bridge-test-config.json',
    );
    expect(sentMarkdown(ctx).some((t) => t.includes('模型已设为'))).toBe(true);
  });
});

describe('/model 提供方卡', () => {
  it('keeps filtered non-chat models out of the 最近使用 quick set', async () => {
    vi.mocked(loadModelData).mockResolvedValue({
      fetchedAt: 1,
      list: [
        { provider: 'futu', selector: 'futu/chat' },
        { provider: 'cursor', selector: 'cursor/other' },
      ],
      commons: [],
    });
    // 直接 /model <selector> 指定过非对话模型 → 它躺在历史里。
    vi.mocked(recentModels).mockResolvedValue(['futu/text-embedding-3-large', 'futu/chat']);

    const ctx = makeCtx({ ompModel: 'cursor/other' });
    await modelHandlers['/model']!('', ctx);

    const card = JSON.stringify(vi.mocked(sendManagedCard).mock.calls[0]![2]);
    expect(card).not.toContain('text-embedding');
    expect(card).toContain('"arg":"futu/chat"');
  });
});
