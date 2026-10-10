import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type * as Shared from '../shared';
import { WorkSessionStore } from '../../session/work-store';
import { handlers, type CommandContext } from '../index';
import { timeoutHandlers } from './timeout';

const { reply } = vi.hoisted(() => ({ reply: vi.fn(async (_ctx: unknown, _text: string) => {}) }));

vi.mock('../shared', async (importOriginal) => {
  const actual = await importOriginal<typeof Shared>();
  return { ...actual, reply };
});

let dir: string;
let store: WorkSessionStore;

function makeCtx(): CommandContext {
  return {
    scope: 'oc_1',
    workSessions: store,
    channel: { send: vi.fn(async () => {}) },
    msg: { chatId: 'oc_1', messageId: 'om_1' },
    chatMode: 'p2p',
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
  store = new WorkSessionStore(join(dir, 'sessions.json'));
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

  it('describes the override as following the chat and only /timeout default clearing it', async () => {
    await timeoutHandlers['/timeout']!('', makeCtx());

    const text = lastReplyText();
    expect(text).toContain('覆盖跟着当前 chat 走');
    expect(text).toContain('`/timeout default`');
    // The old, now-false claim must be gone: /new no longer clears the override.
    expect(text).not.toContain('/new` 会清掉');
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
    expect(lastReplyText()).toContain('回退到全局(60 分钟)');
  });
});
