import { afterEach, describe, expect, it, vi } from 'vitest';
import type { CommandContext } from '../index';
import { thinkingHandlers } from './thinking';
import { saveConfig } from '../../config/store';
import { sendManagedCard, updateManagedCard, forgetManagedCard } from '../../card/managed';
import { loadModelData } from './data';
import type * as DataModule from './data';
import { THINKING_FOLLOW_DEFAULT } from '../../card/model-card';

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

vi.mock('./data', async (importOriginal) => {
  const actual = await importOriginal<typeof DataModule>();
  return { ...actual, loadModelData: vi.fn() };
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
});

describe('/thinking 卡片', () => {
  it('only offers the levels the current model supports (futu/deepseek-v4.1-flash)', async () => {
    vi.mocked(loadModelData).mockResolvedValue({
      fetchedAt: 1,
      list: [
        { provider: 'futu', selector: 'futu/deepseek-v4.1-flash', thinking: ['low', 'high', 'max'] },
      ],
      commons: [],
    });
    const ctx = makeCtx({ ompModel: 'futu/deepseek-v4.1-flash', ompThinking: 'high' });

    await thinkingHandlers['/thinking']!('', ctx);

    const card = JSON.stringify(vi.mocked(sendManagedCard).mock.calls[0]![2]);
    expect(card).toContain('"value":"low"');
    expect(card).toContain('"value":"high"');
    expect(card).toContain('"value":"max"');
    expect(card).not.toContain('"value":"medium"');
    expect(card).not.toContain('"value":"auto"');
    // 「跟随默认」在，且预选/标题都是当前档位。
    expect(card).toContain(`"value":"${THINKING_FOLLOW_DEFAULT}"`);
    expect(card).toContain('"initial_option":"high"');
    expect(card).toContain('当前: `high`');
  });

  it('says the model has no thinking support when the cache entry has an empty thinking list', async () => {
    vi.mocked(loadModelData).mockResolvedValue({
      fetchedAt: 1,
      list: [{ provider: 'futu', selector: 'futu/whisper-like', thinking: [] }],
      commons: [],
    });
    const ctx = makeCtx({ ompModel: 'futu/whisper-like' });

    await thinkingHandlers['/thinking']!('', ctx);

    const card = JSON.stringify(vi.mocked(sendManagedCard).mock.calls[0]![2]);
    expect(card).toContain('该模型不支持思考强度');
    expect(card).toContain(`"value":"${THINKING_FOLLOW_DEFAULT}"`);
    expect(card).not.toContain('"value":"low"');
  });

  it('选择器来自卡片时原地更新，不 recall 也不另发卡（保留托管登记）', async () => {
    vi.mocked(loadModelData).mockResolvedValue({
      fetchedAt: 1,
      list: [{ provider: 'futu', selector: 'futu/deepseek-v4.1-flash', thinking: ['low', 'high'] }],
      commons: [],
    });
    const ctx = makeCtx({
      ompModel: 'futu/deepseek-v4.1-flash',
      ompThinking: 'high',
      fromCardAction: true,
    });

    // 连续两次「打开选择器」（模拟反复点击）：都应走 CardKit 原地更新。
    await thinkingHandlers['/thinking']!('', ctx);
    await thinkingHandlers['/thinking']!('', ctx);

    expect(vi.mocked(sendManagedCard)).not.toHaveBeenCalled();
    expect(recallMessage).not.toHaveBeenCalled();
    expect(vi.mocked(updateManagedCard).mock.calls.map((c) => c[1])).toEqual(['om_1', 'om_1']);
    // 选择器会被反复点击 → 保留托管登记（第二次仍 CardKit，不退化成 patch）。
    expect(vi.mocked(forgetManagedCard)).not.toHaveBeenCalled();
  });
});

describe('/thinking submit', () => {
  it('clears the level when the card submits 跟随默认 (__default)', async () => {
    const ctx = makeCtx({
      ompThinking: 'high',
      formValue: { thinking_level: THINKING_FOLLOW_DEFAULT },
    });
    await thinkingHandlers['/thinking']!('submit', ctx);

    expect(vi.mocked(saveConfig)).toHaveBeenCalledWith(
      expect.objectContaining({
        preferences: expect.objectContaining({ ompThinking: undefined }),
      }),
      '/tmp/feishu-omp-bridge-test-config.json',
    );
    expect(ctx.controls.cfg.preferences?.ompThinking).toBeUndefined();
    expect(sentMarkdown(ctx).some((t) => t.includes('回退 OMP 默认'))).toBe(true);
  });

  it('settles the card as 跟随 OMP 默认 on the card path', async () => {
    const ctx = makeCtx({
      ompThinking: 'high',
      formValue: { thinking_level: THINKING_FOLLOW_DEFAULT },
      fromCardAction: true,
    });

    // 收尾链由 FORM_SETTLE_MS 的定时器驱动 → 用假时钟推进。
    vi.useFakeTimers();
    await thinkingHandlers['/thinking']!('submit', ctx);
    await vi.advanceTimersByTimeAsync(1300);
    vi.useRealTimers();

    const settled = vi.mocked(updateManagedCard).mock.calls.at(-1)?.[2];
    expect(JSON.stringify(settled)).toContain('跟随 OMP 默认');
    expect(ctx.controls.cfg.preferences?.ompThinking).toBeUndefined();
  });

  it('rejects an empty selection instead of silently going to auto', async () => {
    const ctx = makeCtx({ ompThinking: 'high', formValue: {} });
    await thinkingHandlers['/thinking']!('submit', ctx);
    expect(saveConfig).not.toHaveBeenCalled();
    expect(ctx.controls.cfg.preferences?.ompThinking).toBe('high');
    expect(sentMarkdown(ctx).some((t) => t.includes('未选择思考强度'))).toBe(true);
  });
});
