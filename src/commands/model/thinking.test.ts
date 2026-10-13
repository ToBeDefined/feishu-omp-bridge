import { afterEach, describe, expect, it, vi } from 'vitest';
import type { CommandContext } from '../index';
import { thinkingHandlers } from './thinking';
import { saveConfig } from '../../config/store';
import { sendManagedCard, updateManagedCard, forgetManagedCard } from '../../card/managed';
import { loadModelData } from './data';
import type * as DataModule from './data';
import { THINKING_FOLLOW_DEFAULT } from '../../card/model-card';

// 保留真实 reply / updateOrFallback / recallMessage：撤回旧卡走真实链路，
// 用 ctx.channel.rawClient…message.delete 的 spy 观察撤回。
vi.mock('../shared', async (importOriginal) => importOriginal<typeof import('../shared')>());

vi.mock('../../config/store', () => ({
  saveConfig: vi.fn(async () => {}),
}));

vi.mock('../../card/managed', () => ( {
  assertApiOk: vi.fn(),
  managedSequence: vi.fn(() => undefined),
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
  // 真实 recallMessage 会调 im.v1.message.delete 撤回旧卡；patch 故意缺省（不可 patch）。
  const del = vi.fn(async () => ({}));
  return {
    channel: { send, rawClient: { im: { v1: { message: { delete: del } } } } },
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

/** 旧卡撤回（recall）调用的 messageId 列表。 */
function recalls(ctx: CommandContext): string[] {
  const ch = ctx.channel as unknown as { rawClient?: { im: { v1: { message: { delete: { mock: { calls: Array<[{ path: { message_id: string } }]> } } } } } } };
  return ch.rawClient?.im.v1.message.delete.mock.calls.map((c) => c[0].path.message_id) ?? [];
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

  it('选择器来自卡片时换发新卡并撤回旧卡，不再原地更新', async () => {
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

    // 连续两次「打开选择器」（模拟反复点击）：每次都换发新卡（reply 到旧卡）并撤回旧卡。
    await thinkingHandlers['/thinking']!('', ctx);
    await thinkingHandlers['/thinking']!('', ctx);

    expect(vi.mocked(sendManagedCard)).toHaveBeenCalledTimes(2);
    expect(vi.mocked(sendManagedCard).mock.calls.every((c) => c[3] === 'om_1')).toBe(true);
    expect(recalls(ctx)).toEqual(['om_1', 'om_1']);
    // 点击驱动不再走原地更新；旧卡撤回后解除托管登记（新卡由 sendManagedCard 重新登记）。
    expect(vi.mocked(updateManagedCard)).not.toHaveBeenCalled();
    expect(vi.mocked(forgetManagedCard).mock.calls).toEqual([['om_1'], ['om_1']]);
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

    // 收尾链由 FORM_SETTLE_MS 的定时器驱动 → 用假时钟推进（含 ACK 延迟）。
    vi.useFakeTimers();
    await thinkingHandlers['/thinking']!('submit', ctx);
    await vi.advanceTimersByTimeAsync(2000);
    vi.useRealTimers();

    // 点击路径：终态卡以新卡发出（reply 到旧卡），旧卡被撤回。
    const settled = vi.mocked(sendManagedCard).mock.calls.at(-1)?.[2];
    expect(JSON.stringify(settled)).toContain('跟随 OMP 默认');
    expect(recalls(ctx)).toEqual(['om_1']);
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
