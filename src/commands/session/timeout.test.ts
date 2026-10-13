import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type * as Shared from '../shared';
import { SessionStore } from '../../session/store';
import { handlers, type CommandContext } from '../index';
import { timeoutHandlers } from './timeout';

const { reply } = vi.hoisted(() => ({ reply: vi.fn(async (_ctx: unknown, _text: string) => {}) }));
const h = vi.hoisted(() => ({ cards: [] as string[], sends: 0, updates: 0 }));

vi.mock('../shared', async (importOriginal) => {
  const actual = await importOriginal<typeof Shared>();
  return { ...actual, reply };
});

// 卡片路径（sendManagedCard / updateManagedCard）记进数组，断言只看屏幕上的卡。
vi.mock('../../card/managed', () => ( {
  assertApiOk: vi.fn(),
  managedSequence: vi.fn(() => undefined),
  adoptManagedCard: vi.fn(),
  sendManagedCard: async (...args: unknown[]) => {
    h.sends += 1;
    h.cards.push(JSON.stringify(args[2]));
    return { messageId: 'om_card', cardId: 'card_1' };
  },
  updateManagedCard: async (...args: unknown[]) => {
    h.updates += 1;
    h.cards.push(JSON.stringify(args[2]));
  },
  forgetManagedCard: () => {},
}));

let dir: string;
let store: SessionStore;

function makeCtx(fromCardAction = false): CommandContext {
  h.sends = 0;
  h.updates = 0;
  h.cards.length = 0;
  return {
    scope: 'oc_1',
    sessions: store,
    channel: { send: vi.fn(async () => {}) },
    msg: { chatId: 'oc_1', messageId: 'om_1' },
    chatMode: 'p2p',
    fromCardAction,
    activeRuns: {} as never,
    controls: { cfg: { preferences: { runIdleTimeoutMinutes: 60 } } } as never,
  } as unknown as CommandContext;
}

function lastReplyText(): string {
  const call = reply.mock.calls.at(-1);
  return call ? String(call[1]) : '';
}

beforeEach(async () => {
  reply.mockClear();
  dir = await mkdtemp(join(tmpdir(), 'timeout-cmd-'));
  store = new SessionStore(join(dir, 'sessions.json'));
  await store.load();
});

afterEach(async () => {
  await store.flush();
  await rm(dir, { recursive: true, force: true });
});

describe('/timeout command', () => {
  it('is registered as the /timeout command', () => {
    expect(handlers['/timeout']).toBe(timeoutHandlers['/timeout']);
  });

  it('无参发设置卡：当前值 + 四个动作按钮的 payload', async () => {
    store.setIdleTimeoutMinutes('oc_1', 30);
    await timeoutHandlers['/timeout']!('', makeCtx());

    expect(h.sends).toBe(1);
    expect(reply).not.toHaveBeenCalled();
    const out = h.cards.join('\n');
    expect(out).toContain('当前 session 探活: 30 分钟');
    expect(out).toContain('全局默认: 60 分钟');
    // 四个动作按钮走现有 /timeout 语义，payload 明确。
    expect(out).toContain('"cmd":"timeout","arg":"15"');
    expect(out).toContain('"cmd":"timeout","arg":"30"');
    expect(out).toContain('"cmd":"timeout","arg":"off"');
    expect(out).toContain('"cmd":"timeout","arg":"default"');
  });

  it('sets a per-chat override and reports the minutes', async () => {
    await timeoutHandlers['/timeout']!('15', makeCtx());

    expect(store.getIdleTimeoutMinutes('oc_1')).toBe(15);
    expect(lastReplyText()).toContain('已设为 15 分钟');
  });

  it('turns the override off with "off"', async () => {
    await timeoutHandlers['/timeout']!('off', makeCtx());

    expect(store.getIdleTimeoutMinutes('oc_1')).toBe(0);
    expect(lastReplyText()).toContain('已关闭当前 session 的探活');
  });

  it('clears the override and falls back to the global default', async () => {
    store.setIdleTimeoutMinutes('oc_1', 30);
    await timeoutHandlers['/timeout']!('default', makeCtx());

    expect(store.getIdleTimeoutMinutes('oc_1')).toBeUndefined();
    expect(lastReplyText()).toContain('回退到全局（60 分钟）');
  });

  it('拒绝 `1e3`：不再被 parseInt 静默当成 1', async () => {
    await timeoutHandlers['/timeout']!('1e3', makeCtx());

    expect(store.getIdleTimeoutMinutes('oc_1')).toBeUndefined();
    expect(lastReplyText()).toContain('无效的超时值');
    expect(lastReplyText()).toContain('1-120');
  });

  it('拒绝小数与越界值', async () => {
    for (const bad of ['1.5', '121', '-3', 'abc']) {
      reply.mockClear();
      await timeoutHandlers['/timeout']!(bad, makeCtx());
      expect(store.getIdleTimeoutMinutes('oc_1')).toBeUndefined();
      expect(lastReplyText()).toContain('无效的超时值');
    }
  });

  it('卡片点「30 分钟」：原地更新卡，并落库', async () => {
    const ctx = makeCtx(true);
    await timeoutHandlers['/timeout']!('30', ctx);

    expect(store.getIdleTimeoutMinutes('oc_1')).toBe(30);
    expect(h.updates).toBe(1);
    expect(reply).not.toHaveBeenCalled();
    expect(h.cards.at(-1)).toContain('已设为 30 分钟');
    expect(h.cards.at(-1)).toContain('当前 session 探活: 30 分钟');
  });

  it('卡片点「取消」：终态卡不再渲染动作按钮', async () => {
    const ctx = makeCtx(true);
    await timeoutHandlers['/timeout']!('cancel', ctx);

    expect(h.updates).toBe(1);
    const out = h.cards.at(-1)!;
    expect(out).toContain('已取消操作');
    expect(out).not.toContain('"cmd":"timeout"');
    expect(store.getIdleTimeoutMinutes('oc_1')).toBeUndefined();
  });

  it('卡片点非法值：卡上回显错误并给出区间', async () => {
    const ctx = makeCtx(true);
    await timeoutHandlers['/timeout']!('1e3', ctx);

    expect(h.updates).toBe(1);
    expect(h.cards.at(-1)).toContain('无效的超时值');
    expect(h.cards.at(-1)).toContain('1-120');
    expect(store.getIdleTimeoutMinutes('oc_1')).toBeUndefined();
  });
});
