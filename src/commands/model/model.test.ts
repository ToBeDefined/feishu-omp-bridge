import { afterEach, describe, expect, it, vi } from 'vitest';
import { THINKING_FOLLOW_DEFAULT } from '../../card/model-card';
import type { CommandContext } from '../index';
import { modelHandlers } from './model';
import { saveConfig } from '../../config/store';
import { sendManagedCard, updateManagedCard, forgetManagedCard } from '../../card/managed';
import { MAX_HISTORY_ENTRIES, recentModelEntries } from '../../session/model-history';
import type * as HistoryModule from '../../session/model-history';
import { loadModelData } from './data';
import type * as DataModule from './data';

// 保留真实 reply / updateOrFallback，只把 recall 换成 spy：断言「卡片路径不再撤回」。
const { recallMessage } = vi.hoisted(() => ({ recallMessage: vi.fn(async () => {}) }));
vi.mock('../shared', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../shared')>();
  return { ...actual, recallMessage };
});

vi.mock('../../config/store', () => ({
  saveConfig: vi.fn(async () => {}),
}));

vi.mock('../../card/managed', () => ({
  adoptManagedCard: vi.fn(),
  sendManagedCard: vi.fn(async () => ({ messageId: 'om_card', cardId: 'card_1' })),
  updateManagedCard: vi.fn(async () => {}),
  forgetManagedCard: vi.fn(),
}));

// 保留真实实现（isChatModel 是真逻辑），只把取数换成 mock。
vi.mock('./data', async (importOriginal) => {
  const actual = await importOriginal<typeof DataModule>();
  return { ...actual, loadModelData: vi.fn() };
});

// 保留真实实现（上限常量），只把取数换成 mock —— 断言里用得上 MAX_HISTORY_ENTRIES。
vi.mock('../../session/model-history', async (importOriginal) => {
  const actual = await importOriginal<typeof HistoryModule>();
  return { ...actual, recentModelEntries: vi.fn(async () => []) };
});

function makeCtx(overrides: {
  formValue?: Record<string, unknown>;
  ompModel?: string;
  ompThinking?: string;
  fromCardAction?: boolean;
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
    fromCardAction: overrides.fromCardAction,
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
  vi.mocked(updateManagedCard).mockClear();
  vi.mocked(forgetManagedCard).mockClear();
  recallMessage.mockClear();
  vi.mocked(recentModelEntries).mockClear();
  vi.mocked(recentModelEntries).mockResolvedValue([]);
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
    const ctx = makeCtx({ formValue: { model_selector: 'p/a' }, fromCardAction: true });
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
    vi.mocked(recentModelEntries).mockResolvedValue([
      { selector: 'futu/text-embedding-3-large', count: 1 },
      { selector: 'futu/chat', count: 1 },
    ]);

    const ctx = makeCtx({ ompModel: 'cursor/other' });
    await modelHandlers['/model']!('', ctx);

    const card = JSON.stringify(vi.mocked(sendManagedCard).mock.calls[0]![2]);
    expect(card).not.toContain('text-embedding');
    expect(card).toContain('"arg":"futu/chat"');
  });

  it('passes each recent model’s relative time and count to the card (card stays clock-free)', async () => {
    vi.mocked(loadModelData).mockResolvedValue({
      fetchedAt: 1,
      list: [{ provider: 'futu', selector: 'futu/chat' }],
      commons: [],
    });
    // 命令层是唯一读时钟的地方：把 at 算成「…前」交给卡片。
    vi.mocked(recentModelEntries).mockResolvedValue([
      { selector: 'futu/chat', at: Date.now() - 3 * 60_000, count: 5 },
      { selector: 'futu/embedding', at: Date.now() - 2 * 3_600_000, count: 1 },
    ]);

    const ctx = makeCtx({});
    await modelHandlers['/model']!('', ctx);

    // 历史整份取来再过滤（非对话模型会占掉名额，只取 5 条会剩不满 4 个按钮）。
    expect(vi.mocked(recentModelEntries)).toHaveBeenCalledWith(MAX_HISTORY_ENTRIES);
    const card = JSON.stringify(vi.mocked(sendManagedCard).mock.calls[0]![2]);
    expect(card).toContain('chat · 3 分钟前 · 5 次');
  });

  it('卡片路径原地更新提供方卡 / 选择器 / 刷新，不 recall 也不另发卡（并保留托管登记）', async () => {
    vi.mocked(loadModelData).mockResolvedValue({
      fetchedAt: 1,
      list: [
        { provider: 'futu', selector: 'futu/chat' },
        { provider: 'cursor', selector: 'cursor/other' },
      ],
      commons: [],
    });
    const ctx = makeCtx({ ompModel: 'futu/chat', fromCardAction: true });

    // ① 打开提供方卡（来自卡片）② 点提供方 → 选择器 ③ 点「🔄 刷新」。
    await modelHandlers['/model']!('', ctx);
    await modelHandlers['/model']!('provider cursor', ctx);
    await modelHandlers['/model']!('refresh', ctx);

    // 全程没有再发新卡，也不再撤回旧卡。
    expect(vi.mocked(sendManagedCard)).not.toHaveBeenCalled();
    expect(recallMessage).not.toHaveBeenCalled();
    // 每次都原地更新同一个 messageId（om_1）。
    expect(vi.mocked(updateManagedCard).mock.calls.map((c) => c[1])).toEqual([
      'om_1',
      'om_1',
      'om_1',
    ]);
    // 提供方卡 / 选择器会被反复点击 → 保留托管登记。
    expect(vi.mocked(forgetManagedCard)).not.toHaveBeenCalled();
  });
});
