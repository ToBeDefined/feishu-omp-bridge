import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Mock } from 'vitest';
import type { CommandContext } from '../index';
import { wsHandlers } from './ws';

const h = vi.hoisted(() => ({ updates: [] as string[], forgets: 0, recalls: [] as string[] }));

vi.mock('../../card/managed', () => ( {
  assertApiOk: vi.fn(),
  managedSequence: vi.fn(() => undefined),
  adoptManagedCard: vi.fn(),
  updateManagedCard: async (_c: unknown, _id: string, card: unknown) => {
    h.updates.push(JSON.stringify(card));
  },
  forgetManagedCard: () => {
    h.forgets += 1;
  },
  sendManagedCard: vi.fn(),
}));
// 真实 reply / updateOrFallback，只把 recall 换成 spy：/ws cancel 仍应撤回原卡。
vi.mock('../shared', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../shared')>();
  return {
    ...actual,
    recallMessage: async (_ctx: unknown, messageId: string) => {
      h.recalls.push(messageId);
    },
  };
});
vi.mock('../../core/logger', () => ({
  log: { info: vi.fn(), warn: vi.fn(), fail: vi.fn() },
}));

interface WsCtx {
  ctx: CommandContext;
  send: Mock;
  named: Record<string, string>;
}

function makeCtx(
  namedInit: Record<string, string>,
  current: string | undefined,
  fromCardAction: boolean,
): WsCtx {
  const named = { ...namedInit };
  const send = vi.fn(async (..._a: unknown[]) => {});
  const ctx = {
    channel: { send },
    msg: { chatId: 'oc_1', messageId: 'om_card' },
    scope: 'oc_1',
    chatMode: 'p2p',
    fromCardAction,
    workspaces: {
      listNamed: () => ({ ...named }),
      getNamed: (n: string) => named[n],
      cwdFor: () => current,
      saveNamed: (n: string, cwd: string) => {
        named[n] = cwd;
      },
      removeNamed: (n: string) => {
        if (!(n in named)) return false;
        delete named[n];
        return true;
      },
    },
  } as unknown as CommandContext;
  return { ctx, send, named };
}

beforeEach(() => {
  h.updates = [];
  h.forgets = 0;
  h.recalls = [];
  vi.clearAllMocks();
});

describe('/ws 卡片', () => {
  it('删除第一步只进入确认态，不删任何东西', async () => {
    const { ctx, named } = makeCtx({ 'proj-a': '/repo', 'proj-b': '/other' }, '/repo', true);
    await wsHandlers['/ws']!('removeAsk proj-b', ctx);
    expect(named).toHaveProperty('proj-b');
    expect(h.updates).toHaveLength(1);
    expect(h.updates[0]).toContain('"cmd":"ws.remove","name":"proj-b"');
    expect(h.updates[0]).toContain('确认删除工作空间');
    // 首态该行不再出现。
    expect(h.updates[0]).not.toContain('"cmd":"ws.removeAsk","name":"proj-b"');
  });

  it('确认删除后原地刷新列表卡（不是 channel.send 新卡）', async () => {
    const { ctx, send, named } = makeCtx({ 'proj-a': '/repo', 'proj-b': '/other' }, '/repo', true);
    await wsHandlers['/ws']!('remove proj-b', ctx);
    expect(named).not.toHaveProperty('proj-b');
    // 卡片走的是 updateManagedCard；没有新发消息。
    expect(h.updates).toHaveLength(1);
    expect(send).not.toHaveBeenCalled();
    expect(h.updates[0]).toContain('proj-a');
    expect(h.updates[0]).not.toContain('proj-b');
  });

  it('删除确认里点「取消」：原地换回普通列表', async () => {
    const { ctx, send } = makeCtx({ 'proj-a': '/repo', 'proj-b': '/other' }, '/repo', true);
    await wsHandlers['/ws']!('list', ctx);
    expect(send).not.toHaveBeenCalled();
    expect(h.updates[0]).toContain('"cmd":"ws.removeAsk","name":"proj-b"');
  });

  it('面板里保存：原地刷新（新条目出现）而非另发卡片', async () => {
    const { ctx, send, named } = makeCtx({}, '/home/me/proj', true);
    await wsHandlers['/ws']!('save proj', ctx);
    expect(named).toHaveProperty('proj', '/home/me/proj');
    expect(h.updates).toHaveLength(1);
    expect(send).not.toHaveBeenCalled();
    expect(h.updates[0]).toContain('proj');
  });

  it('文本 /ws 仍走 channel.send 新建卡片', async () => {
    const { ctx, send } = makeCtx({ 'proj-a': '/repo' }, '/repo', false);
    await wsHandlers['/ws']!('list', ctx);
    expect(send).toHaveBeenCalled();
    expect(h.updates).toEqual([]);
  });

  it('cancel 仍然撤回原卡（关闭卡片，有意保留 recall，未被顺手改掉）', async () => {
    const { ctx } = makeCtx({ 'proj-a': '/repo' }, '/repo', true);
    await wsHandlers['/ws']!('cancel', ctx);
    expect(h.recalls).toEqual(['om_card']);
    // 不是原地更新成别的卡。
    expect(h.updates).toEqual([]);
  });
});
