import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { CommandContext } from '../index';
import { configHandlers } from './config';
import { saveConfig } from '../../config/store';
import { configFormCard } from '../../card/config-card';
import { updateManagedCard } from '../../card/managed';
import type { AppConfig } from '../../config/schema';

vi.mock('../../card/managed', () => ({
  sendManagedCard: vi.fn(async () => ({ messageId: 'om_card' })),
  updateManagedCard: vi.fn(async () => {}),
  forgetManagedCard: vi.fn(),
}));

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

describe('/config cancel 的兜底', () => {
  beforeEach(() => {
    vi.mocked(updateManagedCard).mockClear();
  });

  it('托管表里没有但消息可 patch 时：卡片被原地改成「已取消」，不再多回一句', async () => {
    vi.mocked(updateManagedCard).mockRejectedValueOnce(new Error('no managed card registered'));
    const patched: string[] = [];
    const sent: string[] = [];
    const { ctx } = ctxWith({});
    (ctx.channel as unknown as { rawClient: unknown }).rawClient = {
      im: { v1: { message: { patch: async (req: { data: { content: string } }) => { patched.push(req.data.content); return { data: {} }; } } } },
    };
    (ctx.channel as unknown as { send: (c: string, p: { markdown?: string }) => Promise<void> }).send =
      async (_c: string, p: { markdown?: string }) => void sent.push(p.markdown ?? '');

    await configHandlers['/config']!('cancel', ctx);
    await new Promise((r) => setTimeout(r, 1300));

    expect(patched).toHaveLength(1);
    expect(patched[0]).toContain('已取消');
    expect(sent).toHaveLength(0);
  });

  it('卡片既不在托管表里也 patch 不了 → 回一条「已取消」而不是静默', async () => {
    // 复现：原地更新抛错（没有托管条目）。
    vi.mocked(updateManagedCard).mockRejectedValueOnce(new Error('no managed card registered'));
    const sent: string[] = [];
    const { ctx } = ctxWith({});
    (ctx.channel as unknown as { send: (c: string, p: { markdown?: string }) => Promise<void> }).send =
      async (_c: string, p: { markdown?: string }) => void sent.push(p.markdown ?? '');

    await configHandlers['/config']!('cancel', ctx);
    await new Promise((r) => setTimeout(r, 1300));   // 等 FORM_SETTLE_MS + 兜底回复

    expect(sent.join('\n')).toContain('已取消');
  });

  it('托管卡片正常时原地更新，不额外回复', async () => {
    const sent: string[] = [];
    const { ctx } = ctxWith({});
    (ctx.channel as unknown as { send: (c: string, p: { markdown?: string }) => Promise<void> }).send =
      async (_c: string, p: { markdown?: string }) => void sent.push(p.markdown ?? '');

    await configHandlers['/config']!('cancel', ctx);
    await new Promise((r) => setTimeout(r, 1300));

    expect(vi.mocked(updateManagedCard)).toHaveBeenCalledTimes(1);
    expect(sent).toHaveLength(0);
  });
});

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

  it('表单卡与保存卡都显示归属者（只读，不进表单字段）', () => {
    const card = JSON.stringify(
      configFormCard({
        messageReply: 'card',
        showToolCalls: true,
        maxConcurrentRuns: 10,
        runIdleTimeoutMinutes: 0,
        requireMentionInGroup: true,
        allowedUsers: '',
        allowedChats: '',
        admins: '',
        owner: 'ou_3a4845d7ce8becd003e2728ab7774666',
      }),
    );
    expect(card).toContain('归属者');
    expect(card).toContain('ou_3a4845d7ce8becd003e2728ab7774666');
    expect(card).toContain('归属者');
    // 收紧成一行：不再有整段说明。
    expect(card).not.toContain('两者都没有则高危命令对所有人拒绝');
    // 不是表单控件：没有 name=owner 的输入框。
    expect(card).not.toContain('"name":"owner"');
  });

  it('提交后保存卡也显示归属者', async () => {
    vi.mocked(updateManagedCard).mockClear();
    const { ctx } = ctxWith({});
    await configHandlers['/config']!('submit', ctx);
    await new Promise((r) => setTimeout(r, 1200));   // 等 FORM_SETTLE_MS 后的原地更新
    const saved = vi.mocked(updateManagedCard).mock.calls.at(-1)?.[2];
    expect(JSON.stringify(saved)).toContain('归属者');
    expect(JSON.stringify(saved)).toContain('ou_3a4845d7ce8becd003e2728ab7774666');
  });

  it('空表单值回落到当前值，同样不丢 owner', async () => {
    const { ctx } = ctxWith({});
    await configHandlers['/config']!('submit', ctx);
    const written = vi.mocked(saveConfig).mock.calls[0]![0] as AppConfig;
    expect(written.preferences?.access?.owner).toBe('ou_3a4845d7ce8becd003e2728ab7774666');
  });
});
