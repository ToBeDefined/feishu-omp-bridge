import { afterEach, describe, expect, it, vi } from 'vitest';
import { THINKING_FOLLOW_DEFAULT } from '../../card/model-card';
import type { CommandContext } from '../index';
import { modelHandlers } from './model';
import { saveConfig } from '../../config/store';

vi.mock('../../config/store', () => ({
  saveConfig: vi.fn(async () => {}),
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

afterEach(() => {
  vi.mocked(saveConfig).mockClear();
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
    const send = ctx.channel.send as unknown as { mock: { calls: Array<[string, { markdown?: string }]> } };

    await modelHandlers['/model']!('submit', ctx);
    await new Promise((r) => setTimeout(r, 1300));   // 等 FORM_SETTLE_MS + 兜底

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
});
