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
