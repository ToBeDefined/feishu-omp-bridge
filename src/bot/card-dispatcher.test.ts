import { describe, expect, it, vi } from 'vitest';
import type { Mock } from 'vitest';
import type { CardActionEvent, LarkChannel, NormalizedMessage } from '@larksuiteoapi/node-sdk';
import { handleCardAction, resolveCardCommand, type CardDispatchDeps } from './card-dispatcher';
import { cardSettlesFlushed } from '../commands/shared';
import type { ActiveRuns } from './active-runs';
import type { ChatModeCache } from './chat-mode-cache';
import type { PendingQueue } from './pending-queue';
import type { AgentAdapter } from '../agent/types';
import type { Controls } from '../commands';
import type { SessionStore } from '../session/store';
import type { WorkspaceStore } from '../workspace/store';
import type * as loggerModule from '../core/logger';
import { AGENT_CALLBACK_MARKER, AGENT_MARK_ISSUED_AT, AGENT_MARK_RUN, AGENT_MARK_SCOPE } from '../card/agent-card';
import { agentSelectedCard } from '../card/templates';

type LoggerModule = typeof loggerModule;

// 失败路径（未登记卡片 → patch 兜底）在测试里会大量打日志，静音掉；
// 其余导出保持真实，免得影响经 `../commands` 拉进来的整张模块图。
vi.mock('../core/logger', async (importOriginal) => {
  const actual = (await importOriginal()) as LoggerModule;
  return { ...actual, log: { ...actual.log, info: vi.fn(), warn: vi.fn(), fail: vi.fn() } };
});

const CHAT_ID = 'oc_chat_1';

// 兜底链（换卡失败 → 原地更新 → patch → 文本回执）第一步要等 ACK 窗口；
// 测试里归零，配合 cardSettlesFlushed() 同步排空后台任务。
process.env.CARD_ACK_DELAY_MS = '0';

describe('agentSelectedCard', () => {
  it('renders a schema-2.0 card showing the frozen choice, without buttons', () => {
    const card = agentSelectedCard('发布') as {
      schema: string;
      body: { elements: Array<{ tag: string; content: string }> };
    };
    expect(card.schema).toBe('2.0');
    expect(card.body.elements).toHaveLength(1);
    expect(card.body.elements[0]?.tag).toBe('markdown');
    expect(card.body.elements[0]?.content).toContain('已选择');
    expect(card.body.elements[0]?.content).toContain('发布');
    expect(JSON.stringify(card)).not.toContain('"button"');
  });

  it('escapes markdown metacharacters in the label', () => {
    const card = agentSelectedCard('a*b_c') as { body: { elements: Array<{ content: string }> } };
    expect(card.body.elements[0]?.content).not.toContain('a*b');
  });
});

describe('resolveCardCommand', () => {
  it('splits a dotted cmd into name + subcommand args', () => {
    const page = resolveCardCommand('history.page', { arg: 'all 8' });
    expect(page).toEqual({ name: 'history', args: 'page all 8' });
    expect(`/${page.name} ${page.args}`).toBe('/history page all 8');

    // No arg → the subcommand alone, never a trailing space.
    expect(resolveCardCommand('search.page', {})).toEqual({ name: 'search', args: 'page' });
  });

  it('leaves the existing history buttons mapping unchanged', () => {
    expect(resolveCardCommand('history.resume', { arg: 'sid' })).toEqual({
      name: 'history',
      args: 'resume sid',
    });
    expect(resolveCardCommand('history.page', { arg: 'all 8' })).toEqual({
      name: 'history',
      args: 'page all 8',
    });
  });
});

interface Harness {
  deps: CardDispatchDeps;
  send: Mock;
  patch: Mock;
  /** 换发新卡：cardkit 建实体 + 回复到旧卡消息。 */
  cardCreate: Mock;
  replyCard: Mock;
  /** 撤回旧卡（rawClient.im.v1.message.delete）。 */
  recall: Mock;
  push: Mock;
  cancel: Mock;
  respondToUi: Mock;
  has: Mock;
  getRunToken: Mock;
}

/**
 * 点击路径的测试替身：只补被测分支真正会碰到的字段。
 * 三张出网口（文本回复 / 消息 patch / OMP 回答）都是可断言的 mock。
 */
function makeHarness(opts: {
  /** 每张卡一个 messageId：去重是进程内按 messageId 记忆的，用例之间不能复用。 */
  messageId: string;
  value: Record<string, unknown>;
  name?: string;
  admins?: string[];
  patchFails?: boolean;
  /** 换发新卡失败（message.reply 抛错）→ 才会退回原地更新 / patch / 文本回执链。 */
  resendFails?: boolean;
  /** activeRuns 的 liveness / run token（agent 卡片过期保护用）。 */
  hasScope?: boolean;
  runToken?: string;
}): Harness {
  const send = vi.fn(async () => ({}));
  const patch = opts.patchFails
    ? vi.fn(async () => {
        throw new Error('patch rejected');
      })
    : vi.fn(async () => ({}));
  const cardCreate = vi.fn(async () => ({ data: { card_id: 'card_new' } }));
  const replyCard = opts.resendFails
    ? vi.fn(async () => {
        throw new Error('resend rejected');
      })
    : vi.fn(async () => ({ data: { message_id: 'om_rerendered' } }));
  const recall = vi.fn(async () => ({}));
  const push = vi.fn((): number => 1);
  const cancel = vi.fn((): NormalizedMessage[] => []);
  const respondToUi = vi.fn((): boolean => true);
  const has = vi.fn((): boolean => opts.hasScope ?? true);
  const getRunToken = vi.fn((): string | undefined => opts.runToken);

  // 出网路径：send + rawClient.im.v1.message.{patch,reply,delete} + cardkit.card.create
  // （点击路径一律换发新卡：cardkit 建实体 → reply 到旧卡消息 → delete 撤回旧卡）。
  const channel = {
    send,
    rawClient: {
      cardkit: { v1: { card: { create: cardCreate } } },
      im: { v1: { message: { patch, reply: replyCard, delete: recall } } },
    },
  } as unknown as LarkChannel;
  const evt = {
    chatId: CHAT_ID,
    messageId: opts.messageId,
    operator: { openId: 'ou_user' },
    action: { value: opts.value, name: opts.name },
  } as unknown as CardActionEvent;
  const deps = {
    channel,
    evt,
    sessions: {} as unknown as SessionStore,
    workspaces: {} as unknown as WorkspaceStore,
    activeRuns: { respondToUi, has, getRunToken } as unknown as ActiveRuns,
    agent: {} as unknown as AgentAdapter,
    controls: {
      cfg: { preferences: { access: { admins: opts.admins ?? [] } } },
      configPath: '/tmp/config.json',
      processId: 'p1',
      restart: async () => {},
      restartProcess: async () => false,
      exit: async () => {},
    } as unknown as Controls,
    pending: { push, cancel } as unknown as PendingQueue,
    chatModeCache: { resolve: async () => 'p2p' as const } as unknown as ChatModeCache,
  };
  return { deps, send, patch, cardCreate, replyCard, recall, push, cancel, respondToUi, has, getRunToken };
}

describe('handleCardAction — 非管理员点击管理员按钮', () => {
  it('回一句可见回执，且不触发 reset 副作用（pending 队列不丢）', async () => {
    const h = makeHarness({ messageId: 'om_denied', value: { cmd: 'exit' }, admins: ['ou_boss'] });
    await handleCardAction(h.deps);

    // 只有回执这一条出网消息，没有别的副作用。
    expect(h.send).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(h.send.mock.calls[0]?.[1])).toContain('仅管理员');
    expect(h.cancel).not.toHaveBeenCalled();
    expect(h.push).not.toHaveBeenCalled();
  });
});

describe('handleCardAction — 卡片已过期 / 未登记', () => {
  it('未登记卡片：换发终态新卡（已过期）并撤回旧卡，且回答仍然送达 OMP', async () => {
    const h = makeHarness({
      messageId: 'om_stale_patchable',
      value: { __omp_ui: true, requestId: 'req_1', title: '选择模型', action: 'cancel' },
    });
    await handleCardAction(h.deps);

    // 回答先送出（语义不变），随后原地更新失败走换卡兜底。
    expect(h.respondToUi).toHaveBeenCalledTimes(1);
    // 点击路径一律换发新卡：cardkit 建实体（终态卡内容）+ 回复到旧卡消息。
    expect(h.cardCreate).toHaveBeenCalledTimes(1);
    const created = JSON.stringify(h.cardCreate.mock.calls[0]);
    expect(created).toContain('已过期');
    // 终态卡不该再带可点按钮。
    expect(created).not.toContain('"button"');
    expect(h.replyCard).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(h.replyCard.mock.calls[0])).toContain('om_stale_patchable');
    // 旧卡撤回，杜绝两份可点的卡并存。
    expect(h.recall).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(h.recall.mock.calls[0])).toContain('om_stale_patchable');
    // 换卡成功就不再 patch，也不补文本，避免同一件事说两遍。
    expect(h.patch).not.toHaveBeenCalled();
    expect(h.send).not.toHaveBeenCalled();
  });

  it('换卡 + patch 都失败时补一条文本回执，绝不静默', async () => {
    const h = makeHarness({
      messageId: 'om_stale_unpatchable',
      value: { __omp_ui: true, requestId: 'req_1', title: '选择模型', action: 'cancel' },
      patchFails: true,
      resendFails: true,
    });
    await handleCardAction(h.deps);
    // 换卡失败后的兜底链是后台任务，排空再断言。
    await cardSettlesFlushed();

    expect(h.respondToUi).toHaveBeenCalledTimes(1);
    expect(h.send).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(h.send.mock.calls[0]?.[1])).toContain('已过期');
  });
});

describe('handleCardAction — 重复点击', () => {
  it('agent 回调：只转发一次，且只提示一次「重复点击」', async () => {
    const h = makeHarness({
      messageId: 'om_dup_agent',
      value: { [AGENT_CALLBACK_MARKER]: true },
      name: '方案 A',
    });
    await handleCardAction(h.deps);
    await handleCardAction(h.deps);
    await handleCardAction(h.deps);

    expect(h.push).toHaveBeenCalledTimes(1);
    expect(h.send).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(h.send.mock.calls[0]?.[1])).toContain('重复点击');
  });

  it('omp-ui：只回答一次 OMP，且只提示一次「重复点击」', async () => {
    const h = makeHarness({
      messageId: 'om_dup_omp_ui',
      value: { __omp_ui: true, requestId: 'req_1', title: '选择模型', action: 'confirm', method: 'confirm' },
    });
    await handleCardAction(h.deps);
    await handleCardAction(h.deps);

    expect(h.respondToUi).toHaveBeenCalledTimes(1);
    // 第一次点击：原地更新失败（未登记）→ 换发结果新卡并撤回旧卡，不补文本。
    expect(h.cardCreate).toHaveBeenCalledTimes(1);
    expect(h.recall).toHaveBeenCalledTimes(1);
    // 唯一的文本出网是第二次点击的「重复点击」提示。
    expect(h.send).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(h.send.mock.calls[0]?.[1])).toContain('重复点击');
  });
});

describe('handleCardAction — OMP UI 结果卡回显 / 空提交', () => {
  it('select 提交后结果卡回显所选值', async () => {
    const h = makeHarness({
      messageId: 'om_ui_echo_select',
      value: {
        __omp_ui: true,
        requestId: 'req_1',
        title: '选择模型',
        method: 'select',
        action: 'submit',
        value: 'gpt-5',
      },
    });
    await handleCardAction(h.deps);

    expect(h.respondToUi).toHaveBeenCalledTimes(1);
    // 点击路径换发结果新卡：回显值在 cardkit 新建的卡实体里，旧卡撤回。
    expect(JSON.stringify(h.cardCreate.mock.calls[0])).toContain('gpt-5');
    expect(h.recall).toHaveBeenCalledTimes(1);
  });

  it('confirm 提交后结果卡回显「确认」', async () => {
    const h = makeHarness({
      messageId: 'om_ui_echo_confirm',
      value: { __omp_ui: true, requestId: 'req_1', title: '确认发布', method: 'confirm', action: 'confirm' },
    });
    await handleCardAction(h.deps);

    expect(h.respondToUi).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(h.cardCreate.mock.calls[0])).toContain('确认');
    expect(h.recall).toHaveBeenCalledTimes(1);
  });

  it('空提交：不回答 OMP、回一句可见提示、卡片保持可操作', async () => {
    const h = makeHarness({
      messageId: 'om_ui_empty_submit',
      value: { __omp_ui: true, requestId: 'req_1', title: '选择模型', method: 'select', action: 'submit', value: '' },
    });
    await handleCardAction(h.deps);

    expect(h.respondToUi).not.toHaveBeenCalled();
    expect(h.patch).not.toHaveBeenCalled();
    expect(h.send).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(h.send.mock.calls[0]?.[1])).toContain('请先选择');
  });
});

describe('handleCardAction — agent 卡片过期保护', () => {
  it('__omp_run 与当前 run 不匹配 → 回「任务已结束」且不透传', async () => {
    const h = makeHarness({
      messageId: 'om_agent_stale_run',
      value: {
        [AGENT_CALLBACK_MARKER]: true,
        [AGENT_MARK_SCOPE]: CHAT_ID,
        [AGENT_MARK_RUN]: 'old-run',
        [AGENT_MARK_ISSUED_AT]: Date.now(),
      },
      runToken: 'new-run',
    });
    await handleCardAction(h.deps);

    expect(h.push).not.toHaveBeenCalled();
    expect(h.send).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(h.send.mock.calls[0]?.[1])).toContain('任务已结束');
  });

  it('发行时间超过 TTL → 回「任务已结束」且不透传', async () => {
    const h = makeHarness({
      messageId: 'om_agent_stale_ttl',
      value: {
        [AGENT_CALLBACK_MARKER]: true,
        [AGENT_MARK_SCOPE]: CHAT_ID,
        [AGENT_MARK_ISSUED_AT]: Date.now() - 31 * 60_000,
      },
    });
    await handleCardAction(h.deps);

    expect(h.push).not.toHaveBeenCalled();
    expect(JSON.stringify(h.send.mock.calls[0]?.[1])).toContain('任务已结束');
  });

  it('有效标记：透传，但不把 __omp_* 混进 [card-click] JSON', async () => {
    const h = makeHarness({
      messageId: 'om_agent_valid',
      value: {
        [AGENT_CALLBACK_MARKER]: true,
        action: 'deploy',
        [AGENT_MARK_SCOPE]: CHAT_ID,
        [AGENT_MARK_RUN]: 'run-current',
        [AGENT_MARK_ISSUED_AT]: Date.now(),
      },
      runToken: 'run-current',
    });
    await handleCardAction(h.deps);

    expect(h.push).toHaveBeenCalledTimes(1);
    const content = (h.push.mock.calls[0]?.[1] as NormalizedMessage).content;
    expect(content).toContain('[card-click]');
    expect(content).toContain('deploy');
    expect(content).not.toContain('__omp_');
  });

  it('无标记的手工卡片行为不变：照常透传', async () => {
    const h = makeHarness({
      messageId: 'om_agent_manual',
      value: { [AGENT_CALLBACK_MARKER]: true, action: 'go' },
    });
    await handleCardAction(h.deps);

    expect(h.push).toHaveBeenCalledTimes(1);
  });
});

describe('handleCardAction — 命令按钮时间窗去重', () => {
  it('同一卡同一按钮 2s 内连点只执行一次，超窗后再次点击会执行', async () => {
    vi.useFakeTimers();
    try {
      const h = makeHarness({ messageId: 'om_cmd_dedup', value: { cmd: 'new' } });
      await handleCardAction(h.deps);
      await handleCardAction(h.deps);
      expect(h.cancel).toHaveBeenCalledTimes(1);

      vi.advanceTimersByTime(2_001);
      await handleCardAction(h.deps);
      expect(h.cancel).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });
});
