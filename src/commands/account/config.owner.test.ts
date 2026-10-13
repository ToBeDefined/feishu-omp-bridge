import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { CommandContext } from '../index';
import { configHandlers } from './config';
import { saveConfig } from '../../config/store';
import { configFormCard } from '../../card/config-card';
import { forgetManagedCard, sendManagedCard, updateManagedCard } from '../../card/managed';
import type { AppConfig } from '../../config/schema';

vi.mock('../../card/managed', () => ({
  adoptManagedCard: vi.fn(),
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

// recallMessage 在 shared.ts 内部（不走 mock）；用 deleteMessage 观察它真正打的线。
const deleteMessage = vi.fn(async (_req: unknown) => ({ data: {} }));

function ctxWith(formValue: Record<string, unknown>) {
  const cfg = structuredClone(baseCfg);
  const ctx = {
    channel: { send: async () => {}, rawClient: { im: { v1: { message: { delete: deleteMessage } } } } },
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
    // 补救链路：把消息内容整体替换成终态卡。
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
    expect(card).toContain('**归属者**（只读）:`ou_3a4845d7ce8becd003e2728ab7774666`');
    // 只要这一行：不再带「为什么只读 / 怎么回落」的解释。
    expect(card).not.toContain('防远端提权');
    expect(card).not.toContain('admins 第一个');
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

  it('表单缺 show_tool_calls 时保留当前值（不再把「隐藏」静默改回「显示」）', async () => {
    const { ctx, cfg } = ctxWith({ message_reply: 'card' });
    (cfg.preferences as { showToolCalls?: boolean }).showToolCalls = false;
    await configHandlers['/config']!('submit', ctx);
    const written = vi.mocked(saveConfig).mock.calls[0]![0] as AppConfig;
    expect(written.preferences?.showToolCalls).toBe(false);
  });

  it('表单明确回传 hide 时按表单走', async () => {
    const { ctx, cfg } = ctxWith({ show_tool_calls: 'hide' });
    (cfg.preferences as { showToolCalls?: boolean }).showToolCalls = true;
    await configHandlers['/config']!('submit', ctx);
    const written = vi.mocked(saveConfig).mock.calls[0]![0] as AppConfig;
    expect(written.preferences?.showToolCalls).toBe(false);
  });

  it('空表单值回落到当前值，同样不丢 owner', async () => {
    const { ctx } = ctxWith({});
    await configHandlers['/config']!('submit', ctx);
    const written = vi.mocked(saveConfig).mock.calls[0]![0] as AppConfig;
    expect(written.preferences?.access?.owner).toBe('ou_3a4845d7ce8becd003e2728ab7774666');
  });
});

interface CapturedSend {
  markdown?: string;
  card?: object;
}

/** 把 channel.send 换成收集器（测试里唯一需要绕过 CommandContext 类型的地方）。 */
function captureSends(ctx: CommandContext): CapturedSend[] {
  const sent: CapturedSend[] = [];
  const channel: unknown = ctx.channel;
  if (typeof channel !== 'object' || channel === null) return sent;
  (channel as { send: (chatId: string, payload: CapturedSend) => Promise<void> }).send =
    async (_chatId, payload) => {
      sent.push(payload);
    };
  return sent;
}

describe('/config submit 的数值校验', () => {
  beforeEach(() => {
    vi.mocked(saveConfig).mockClear();
    vi.mocked(updateManagedCard).mockClear();
  });

  it('拒绝越界的并发上限（旧行为：静默 clamp 成 50 还回「已保存」）', async () => {
    const { ctx, cfg } = ctxWith({ max_concurrent_runs: '999' });
    const sent = captureSends(ctx);
    (cfg.preferences as { maxConcurrentRuns?: number }).maxConcurrentRuns = 10;

    await configHandlers['/config']!('submit', ctx);

    expect(saveConfig).not.toHaveBeenCalled();
    expect((cfg.preferences as { maxConcurrentRuns?: number }).maxConcurrentRuns).toBe(10);
    const cards = JSON.stringify(sent.map((s) => s.card));
    expect(cards).toContain('提交被拒绝');
    expect(cards).toContain('并发上限');
    expect(cards).toContain('1-50');
    expect(cards).toContain('999');
    expect(cards).not.toContain('偏好已保存');
  });

  it('把 1e3 / 5.5 / abc 当非法，而不是被 parseInt 截断', async () => {
    for (const bad of ['1e3', '5.5', 'abc']) {
      const { ctx } = ctxWith({
        max_concurrent_runs: bad,
        run_idle_timeout_minutes: bad,
      });
      const sent = captureSends(ctx);
      await configHandlers['/config']!('submit', ctx);
      expect(saveConfig).not.toHaveBeenCalled();
      const cards = JSON.stringify(sent.map((s) => s.card));
      expect(cards).toContain('并发上限');
      expect(cards).toContain('run 探活');
      expect(cards).toContain(bad);
    }
  });

  it('合法整数照常保存', async () => {
    const { ctx } = ctxWith({ max_concurrent_runs: '7', run_idle_timeout_minutes: '30' });
    await configHandlers['/config']!('submit', ctx);
    const written = vi.mocked(saveConfig).mock.calls[0]![0] as AppConfig;
    expect(written.preferences?.maxConcurrentRuns).toBe(7);
    expect(written.preferences?.runIdleTimeoutMinutes).toBe(30);
  });

  it('字段缺失（CardKit 丢字段）仍回落当前值，不算非法', async () => {
    const { ctx, cfg } = ctxWith({});
    (cfg.preferences as { maxConcurrentRuns?: number }).maxConcurrentRuns = 12;
    await configHandlers['/config']!('submit', ctx);
    const written = vi.mocked(saveConfig).mock.calls[0]![0] as AppConfig;
    expect(written.preferences?.maxConcurrentRuns).toBe(12);
  });
});

describe('/config submit 写盘失败', () => {
  beforeEach(() => {
    vi.mocked(saveConfig).mockReset();
    vi.mocked(saveConfig).mockResolvedValue();
    vi.mocked(updateManagedCard).mockClear();
    vi.mocked(updateManagedCard).mockResolvedValue();
  });

  it('换成明确的失败卡（写清原因），不再谎称「已取消」', async () => {
    const { ctx } = ctxWith({ max_concurrent_runs: '7' });
    captureSends(ctx);
    vi.mocked(saveConfig).mockRejectedValueOnce(new Error('EACCES: permission denied'));

    // 收尾链由 FORM_SETTLE_MS 的定时器驱动 → 用假时钟推进，不真等 1.3s。
    vi.useFakeTimers();
    await configHandlers['/config']!('submit', ctx);
    await vi.advanceTimersByTimeAsync(1300);
    vi.useRealTimers();

    const settled = JSON.stringify(vi.mocked(updateManagedCard).mock.calls.at(-1)?.[2]);
    expect(settled).toContain('偏好保存失败');
    expect(settled).toContain('EACCES: permission denied');
    expect(settled).not.toContain('已取消');
    // 配置内存态没被写脏。
    expect(ctx.controls.cfg.preferences?.maxConcurrentRuns).not.toBe(7);
  });

  it('卡片更新不了时补发一条文本（有兜底，不静默）', async () => {
    const { ctx } = ctxWith({ max_concurrent_runs: '7' });
    const sent = captureSends(ctx);
    vi.mocked(saveConfig).mockRejectedValueOnce(new Error('ENOSPC: no space left'));

    vi.useFakeTimers();
    await configHandlers['/config']!('submit', ctx);
    vi.mocked(updateManagedCard).mockRejectedValueOnce(new Error('no managed card registered'));
    await vi.advanceTimersByTimeAsync(1300);
    vi.useRealTimers();

    expect(sent.map((s) => s.markdown ?? '').join('\n')).toContain('偏好保存失败');
    expect(sent.map((s) => s.markdown ?? '').join('\n')).toContain('ENOSPC');
  });
});

describe('/config 重开偏好表单卡', () => {
  beforeEach(() => {
    vi.mocked(sendManagedCard).mockClear();
    vi.mocked(updateManagedCard).mockClear();
    vi.mocked(updateManagedCard).mockResolvedValue();
    vi.mocked(forgetManagedCard).mockClear();
  });

  it('卡片点击 → 重开表单补发新卡并撤回旧卡（不再原地更新）', async () => {
    const { ctx } = ctxWith({});
    deleteMessage.mockClear();
    await configHandlers['/config']!('', ctx);

    // 补发一张新表单卡（第三参就是新卡，带 config.submit）。
    expect(vi.mocked(sendManagedCard)).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(vi.mocked(sendManagedCard).mock.calls[0]![2])).toContain(
      'config.submit',
    );
    // 撤回被点击的旧卡（om_1）。
    expect(deleteMessage).toHaveBeenCalledTimes(1);
    expect(deleteMessage).toHaveBeenCalledWith({ path: { message_id: 'om_1' } });
    // 这条路径不再原地更新。
    expect(vi.mocked(updateManagedCard)).not.toHaveBeenCalled();
  });

  it('文本入口（非卡片）仍发新表单卡', async () => {
    const { ctx } = ctxWith({});
    ctx.fromCardAction = false;

    await configHandlers['/config']!('', ctx);

    expect(vi.mocked(sendManagedCard)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(updateManagedCard)).not.toHaveBeenCalled();
  });
});
