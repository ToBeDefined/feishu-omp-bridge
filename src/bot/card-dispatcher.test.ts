import { describe, expect, it, vi } from 'vitest';
import type { Mock } from 'vitest';
import type { CardActionEvent, LarkChannel, NormalizedMessage } from '@larksuiteoapi/node-sdk';
import { handleCardAction, resolveCardCommand, type CardDispatchDeps } from './card-dispatcher';
import type { ActiveRuns } from './active-runs';
import type { ChatModeCache } from './chat-mode-cache';
import type { PendingQueue } from './pending-queue';
import type { AgentAdapter } from '../agent/types';
import type { Controls } from '../commands';
import type { SessionStore } from '../session/store';
import type { WorkspaceStore } from '../workspace/store';
import type * as loggerModule from '../core/logger';
import { AGENT_CALLBACK_MARKER } from '../card/agent-card';
import { agentSelectedCard } from '../card/templates';

type LoggerModule = typeof loggerModule;

// 失败路径（未登记卡片 → patch 兜底）在测试里会大量打日志，静音掉；
// 其余导出保持真实，免得影响经 `../commands` 拉进来的整张模块图。
vi.mock('../core/logger', async (importOriginal) => {
  const actual = (await importOriginal()) as LoggerModule;
  return { ...actual, log: { ...actual.log, info: vi.fn(), warn: vi.fn(), fail: vi.fn() } };
});

const CHAT_ID = 'oc_chat_1';

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
  push: Mock;
  cancel: Mock;
  respondToUi: Mock;
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
}): Harness {
  const send = vi.fn(async () => ({}));
  const patch = opts.patchFails
    ? vi.fn(async () => {
        throw new Error('patch rejected');
      })
    : vi.fn(async () => ({}));
  const push = vi.fn((): number => 1);
  const cancel = vi.fn((): NormalizedMessage[] => []);
  const respondToUi = vi.fn((): boolean => true);

  // 只用到 send + rawClient.im.v1.message.patch 两条出网路径。
  const channel = {
    send,
    rawClient: { im: { v1: { message: { patch } } } },
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
    activeRuns: { respondToUi } as unknown as ActiveRuns,
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
  return { deps, send, patch, push, cancel, respondToUi };
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
  it('未登记卡片：把卡 patch 成「已过期」终态，且回答仍然送达 OMP', async () => {
    const h = makeHarness({
      messageId: 'om_stale_patchable',
      value: { __omp_ui: true, requestId: 'req_1', title: '选择模型', action: 'cancel' },
    });
    await handleCardAction(h.deps);

    // 回答先送出（语义不变），随后卡片更新失败才走兜底。
    expect(h.respondToUi).toHaveBeenCalledTimes(1);
    expect(h.patch).toHaveBeenCalledTimes(1);
    const patched = JSON.stringify(h.patch.mock.calls[0]);
    expect(patched).toContain('已过期');
    expect(patched).toContain('om_stale_patchable');
    // 终态卡不该再带可点按钮。
    expect(patched).not.toContain('"button"');
    // patch 成功了就不再补文本，避免同一件事说两遍。
    expect(h.send).not.toHaveBeenCalled();
  });

  it('patch 也失败时补一条文本回执，绝不静默', async () => {
    const h = makeHarness({
      messageId: 'om_stale_unpatchable',
      value: { __omp_ui: true, requestId: 'req_1', title: '选择模型', action: 'cancel' },
      patchFails: true,
    });
    await handleCardAction(h.deps);

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
      patchFails: true,
    });
    await handleCardAction(h.deps);
    await handleCardAction(h.deps);

    expect(h.respondToUi).toHaveBeenCalledTimes(1);
    // 第一次的兜底回执 + 一次重复点击提示。
    expect(h.send).toHaveBeenCalledTimes(2);
    expect(JSON.stringify(h.send.mock.calls[0]?.[1])).toContain('已过期');
    expect(JSON.stringify(h.send.mock.calls[1]?.[1])).toContain('重复点击');
  });
});
