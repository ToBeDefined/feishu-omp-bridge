import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { CommandContext } from '../index';
import { configHandlers } from './config';
import { saveConfig } from '../../config/store';
import type { AppConfig } from '../../config/schema';

vi.mock('../../config/store', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../config/store')>();
  return { ...actual, saveConfig: vi.fn(async () => {}) };
});

const baseCfg = {
  accounts: { app: { id: 'cli_x', tenant: 'feishu' } },
  preferences: {
    ompModel: 'futu/deepseek-v4.1-flash',
    ompThinking: 'auto',
    access: {
      owner: 'ou_3a4845d7ce8becd003e2728ab7774666',
      allowedUsers: ['ou_other'],
      allowedChats: [],
      admins: [],
    },
  },
} as unknown as AppConfig;

function ctxWith(formValue: Record<string, unknown>) {
  const cfg = structuredClone(baseCfg);
  const ctx = {
    channel: { send: async () => {} },
    msg: { chatId: 'oc_1', messageId: 'om_1', content: '', senderId: 'ou_3a4845d7ce8becd003e2728ab7774666' },
    scope: 'oc_1',
    chatMode: 'p2p',
    fromCardAction: true,
    controls: { cfg, configPath: '/tmp/nonexistent-config.json' },
    formValue,
  } as unknown as CommandContext;
  return { ctx, cfg };
}

describe('/config submit 与 access.owner', () => {
  beforeEach(() => {
    vi.mocked(saveConfig).mockClear();
  });

  it('提交时原样保留不在表单里的 access.owner（回归：一次提交曾把它抹掉）', async () => {
    const { ctx } = ctxWith({
      message_reply: 'card',
      show_tool_calls: 'show',
      max_concurrent_runs: '10',
      run_idle_timeout_minutes: '0',
      require_mention_in_group: 'yes',
      allowed_users: '',
      allowed_chats: '',
      admins: '',
    });

    await configHandlers['/config']!('submit', ctx);

    expect(vi.mocked(saveConfig)).toHaveBeenCalledTimes(1);
    const written = vi.mocked(saveConfig).mock.calls[0]![0] as AppConfig;
    expect(written.preferences?.access?.owner).toBe('ou_3a4845d7ce8becd003e2728ab7774666');
    expect(written.preferences?.access?.allowedUsers).toEqual([]);
    // 表单字段照常生效；ompModel / ompThinking 也不受影响（spread 保留）。
    expect(written.preferences?.messageReply).toBe('card');
    expect(written.preferences?.ompModel).toBe('futu/deepseek-v4.1-flash');
    expect(written.preferences?.ompThinking).toBe('auto');
  });

  it('空表单值回落到当前值，同样不丢 owner', async () => {
    const { ctx } = ctxWith({});
    await configHandlers['/config']!('submit', ctx);
    const written = vi.mocked(saveConfig).mock.calls[0]![0] as AppConfig;
    expect(written.preferences?.access?.owner).toBe('ou_3a4845d7ce8becd003e2728ab7774666');
  });
});
