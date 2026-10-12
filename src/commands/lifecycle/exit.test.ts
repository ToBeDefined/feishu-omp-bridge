import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Mock } from 'vitest';
import type { CommandContext } from '../index';
import { exitHandlers } from './exit';

const h = vi.hoisted(() => ({
  registry: [] as Array<{ id: string; appId: string; pid: number; startedAt: string }>,
  alive: true,
  dead: [] as string[],
  updates: [] as string[],
  forgets: 0,
}));

vi.mock('../../runtime/registry', () => ({
  readAndPrune: () => h.registry.filter((e) => !h.dead.includes(e.id)),
  resolveTarget: (t: string) =>
    /^\d+$/.test(t) ? h.registry[Number(t) - 1] : h.registry.find((e) => e.id === t),
  isAlive: () => h.alive,
}));
vi.mock('../../card/managed', () => ({
  updateManagedCard: async (_c: unknown, _id: string, card: unknown) => {
    h.updates.push(JSON.stringify(card));
  },
  forgetManagedCard: () => {
    h.forgets += 1;
  },
  sendManagedCard: vi.fn(),
}));
vi.mock('../../core/logger', () => ({
  log: { info: vi.fn(), warn: vi.fn(), fail: vi.fn() },
}));

interface ExitCtx {
  ctx: CommandContext;
  send: Mock;
  exit: Mock;
  /** Text (markdown) bodies this ctx's channel.send received. */
  texts: string[];
}

function makeCtx(fromCardAction: boolean): ExitCtx {
  const texts: string[] = [];
  const send = vi.fn(async (_chatId: string, payload: { markdown?: string }) => {
    texts.push(payload.markdown ?? '');
  });
  const exit = vi.fn(async () => {});
  const ctx = {
    channel: { send },
    msg: { chatId: 'oc_1', messageId: 'om_card' },
    scope: 'oc_1',
    chatMode: 'p2p',
    fromCardAction,
    controls: { processId: 'p1', exit },
  } as unknown as CommandContext;
  return { ctx, send, exit, texts };
}

let killSpy: Mock;

beforeEach(() => {
  h.registry = [
    { id: 'p1', appId: 'cli_a', pid: 111, startedAt: new Date().toISOString() },
    { id: 'p2', appId: 'cli_b', pid: 222, startedAt: new Date().toISOString() },
  ];
  h.alive = true;
  h.dead = [];
  h.updates = [];
  h.forgets = 0;
  vi.restoreAllMocks();
  killSpy = vi.spyOn(process, 'kill').mockReturnValue(true) as unknown as Mock;
});

describe('/exit', () => {
  it('ask：只把 /ps 卡换成确认态，不杀任何进程', async () => {
    const { ctx, send } = makeCtx(true);
    await exitHandlers['/exit']!('ask p2', ctx);
    expect(killSpy).not.toHaveBeenCalled();
    expect(h.updates).toHaveLength(1);
    expect(h.updates[0]).toContain('"cmd":"exit","arg":"p2"');
    expect(h.updates[0]).not.toContain('"cmd":"exit.ask","arg":"p2"');
    expect(send).not.toHaveBeenCalled();
  });

  it('cancel：把确认态换回普通列表，原地更新', async () => {
    const { ctx, send } = makeCtx(true);
    await exitHandlers['/exit']!('cancel p2', ctx);
    expect(h.updates).toHaveLength(1);
    expect(h.updates[0]).toContain('"cmd":"exit.ask","arg":"p2"');
    expect(send).not.toHaveBeenCalled();
  });

  it('确认后关闭其它进程：卡片被原地更新（不是新发一张）', async () => {
    h.alive = false;
    h.dead = ['p2'];
    const { ctx, send } = makeCtx(true);
    await exitHandlers['/exit']!('p2', ctx);
    expect(killSpy.mock.calls.map((c) => c[0])).toEqual([222]);
    // 走的是 updateManagedCard（updateOrFallback），没有 channel.send 新卡。
    expect(h.updates).toHaveLength(1);
    expect(send).not.toHaveBeenCalled();
    // 已死进程被剪掉，卡上不再有它的执行按钮。
    expect(h.updates[0]).not.toContain('"arg":"p2"');
  });

  it('文本调用仍是纯文本回复（不进卡片路径）', async () => {
    h.alive = false;
    const { ctx, send, texts } = makeCtx(false);
    await exitHandlers['/exit']!('p2', ctx);
    expect(h.updates).toEqual([]);
    expect(texts.some((m) => m.includes('已关闭 bot'))).toBe(true);
    expect(send).toHaveBeenCalled();
  });

  it('关闭当前进程：先把卡换成告别态再退出', async () => {
    const { ctx, send, exit } = makeCtx(true);
    await exitHandlers['/exit']!('p1', ctx);
    expect(h.updates).toHaveLength(1);
    expect(h.updates[0]).toContain('即将退出');
    expect(h.updates[0]).not.toContain('"cmd":"exit');
    expect(send).not.toHaveBeenCalled();
    await vi.waitFor(() => expect(exit).toHaveBeenCalled());
  });

  it('无参数：回复用法', async () => {
    const { ctx, texts } = makeCtx(false);
    await exitHandlers['/exit']!('', ctx);
    expect(texts.some((m) => m.includes('用法'))).toBe(true);
  });
});
