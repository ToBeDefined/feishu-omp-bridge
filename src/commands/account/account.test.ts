import { beforeEach, describe, expect, it, vi } from 'vitest';
type ConfigStoreModule = typeof import('../../config/store');

// 只桩 I/O 边界（keystore / config 落盘 / 飞书校验 / 卡片投递），
// 命令编排与卡片内容走真实代码。
const h = vi.hoisted(() => ({
  setSecret: vi.fn(async (..._args: unknown[]) => {}),
  removeSecret: vi.fn(async (..._args: unknown[]) => true),
  saveConfig: vi.fn(async (..._args: unknown[]) => {}),
  buildEncryptedAccountConfig: vi.fn(async (..._args: unknown[]) => ({
    accounts: { app: { id: 'cli_new', tenant: 'feishu' } },
  })),
  validateAppCredentials: vi.fn(async (..._args: unknown[]) => ({ ok: true, botName: '尼莫' })),
  sendManagedCard: vi.fn(async (..._args: unknown[]) => ({ messageId: 'om_card' })),
  updateManagedCard: vi.fn(async (..._args: unknown[]) => {}),
  forgetManagedCard: vi.fn(),
  recallMessage: vi.fn(async (..._args: unknown[]) => {}),
}));

// 真实 reply / updateOrFallback，只把 recall 换成 spy：断言卡片路径不再撤回。
vi.mock('../shared', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../shared')>();
  return { ...actual, recallMessage: h.recallMessage };
});

vi.mock('../../config/keystore', () => ({
  setSecret: h.setSecret,
  removeSecret: h.removeSecret,
  getSecret: vi.fn(async () => undefined),
  listSecretIds: vi.fn(async () => []),
}));
vi.mock('../../config/store', async (importOriginal) => {
  const actual = (await importOriginal()) as ConfigStoreModule;
  return {
    ...actual,
    buildEncryptedAccountConfig: h.buildEncryptedAccountConfig,
    saveConfig: h.saveConfig,
  };
});
vi.mock('../../utils/feishu-auth', () => ({ validateAppCredentials: h.validateAppCredentials }));
vi.mock('../../card/managed', () => ({
  sendManagedCard: h.sendManagedCard,
  updateManagedCard: h.updateManagedCard,
  forgetManagedCard: h.forgetManagedCard,
  finalizeInterruptedCards: vi.fn(async () => false),
}));

import type { CommandContext } from '../index';
import { accountCmdHandlers } from './account';

const baseCfg = {
  accounts: {
    app: {
      id: 'cli_old',
      tenant: 'feishu',
      secret: { source: 'exec', provider: 'bridge', id: 'app-cli_old' },
    },
  },
  preferences: {},
};

function makeCtx(): CommandContext {
  return {
    channel: { send: vi.fn(async () => {}) },
    msg: { chatId: 'oc_1', messageId: 'om_1', content: '', senderId: 'ou_1' },
    scope: 'oc_1',
    chatMode: 'p2p',
    fromCardAction: false,
    controls: {
      cfg: baseCfg,
      configPath: '/tmp/fob-account-test/config.json',
      processId: 'e001',
      scheduler: {} as never,
      exit: async () => {},
      restart: async () => {},
      restartProcess: async () => true,
    },
    formValue: { app_id: 'cli_new', app_secret: 'topsecret', tenant: 'feishu' },
  } as unknown as CommandContext;
}

function lastCard(): string {
  return JSON.stringify(h.updateManagedCard.mock.calls.at(-1)?.[2] ?? {});
}

beforeEach(() => {
  for (const m of Object.values(h)) m.mockClear();
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

describe('/account submit 的凭据落盘时序', () => {
  // 每条用例必须等到「自己的卡片」落地才能结束 —— submit 是分离的异步
  // 任务，提前结束会让上一条的尾包串进下一条的断言。
  it('saveConfig 失败：best-effort 删除刚写入的 secret，再报原始错误', async () => {
    h.saveConfig.mockRejectedValueOnce(new Error('disk full'));
    const ctx = makeCtx();

    await accountCmdHandlers['/account']!('submit', ctx);

    await vi.waitFor(() => expect(h.removeSecret).toHaveBeenCalledWith('app-cli_new'), {
      timeout: 5000,
    });
    await vi.waitFor(() => expect(h.updateManagedCard).toHaveBeenCalled(), { timeout: 5000 });
    expect(h.setSecret).toHaveBeenCalledWith('app-cli_new', 'topsecret');
    // 顺序契约：先写 secret → 再存 config → 失败后回滚 secret。
    expect(h.setSecret.mock.invocationCallOrder[0]).toBeLessThan(
      h.saveConfig.mock.invocationCallOrder[0]!,
    );
    expect(h.saveConfig.mock.invocationCallOrder[0]).toBeLessThan(
      h.removeSecret.mock.invocationCallOrder[0]!,
    );
    // 失败卡片如实给出原始错误（不带回滚噪音）。
    const card = lastCard();
    expect(card).toContain('保存凭据失败');
    expect(card).toContain('disk full');
    expect(card).not.toContain('removeSecret');
  });

  it('saveConfig 成功：绝不触发回滚', async () => {
    const ctx = makeCtx();

    await accountCmdHandlers['/account']!('submit', ctx);

    await vi.waitFor(() => expect(h.updateManagedCard).toHaveBeenCalled(), { timeout: 5000 });
    expect(h.setSecret).toHaveBeenCalledWith('app-cli_new', 'topsecret');
    expect(h.saveConfig).toHaveBeenCalledTimes(1);
    expect(h.removeSecret).not.toHaveBeenCalled();
    expect(lastCard()).toContain('cli_new');
  });

  it('回滚本身失败：吞掉回滚错误，用户看到的仍是原始保存错误', async () => {
    h.saveConfig.mockRejectedValueOnce(new Error('disk full'));
    h.removeSecret.mockRejectedValueOnce(new Error('keystore sealed'));
    const ctx = makeCtx();

    await accountCmdHandlers['/account']!('submit', ctx);

    await vi.waitFor(() => expect(h.updateManagedCard).toHaveBeenCalled(), { timeout: 5000 });
    const card = lastCard();
    expect(card).toContain('保存凭据失败');
    expect(card).toContain('disk full');
    expect(card).not.toContain('keystore sealed');
  });
});

describe('/account change / cancel 的卡片路径', () => {
  it('从卡片点「更换凭据」：原地更新同一 messageId，不撤回也不另发卡', async () => {
    const ctx = makeCtx();
    ctx.fromCardAction = true;

    await accountCmdHandlers['/account']!('change', ctx);

    expect(h.recallMessage).not.toHaveBeenCalled();
    expect(h.sendManagedCard).not.toHaveBeenCalled();
    expect(h.updateManagedCard).toHaveBeenCalledWith(expect.anything(), 'om_1', expect.anything());
    expect(lastCard()).toContain('更换凭据');
  });

  it('文本入口（非卡片）仍发新表单卡', async () => {
    const ctx = makeCtx();

    await accountCmdHandlers['/account']!('change', ctx);

    expect(h.recallMessage).not.toHaveBeenCalled();
    expect(h.sendManagedCard).toHaveBeenCalledTimes(1);
  });

  it('cancel 仍然撤回原卡（有意保留 recall，未被顺手改掉）', async () => {
    const ctx = makeCtx();
    ctx.fromCardAction = true;

    await accountCmdHandlers['/account']!('cancel', ctx);

    expect(h.recallMessage).toHaveBeenCalledWith(ctx, 'om_1');
    expect(h.updateManagedCard).not.toHaveBeenCalled();
  });
});
