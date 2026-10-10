import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import type * as Shared from '../shared';
import { WorkSessionStore } from '../../session/work-store';
import { handlers, type CommandContext } from '../index';
import { handleWork } from './work';

const { reply } = vi.hoisted(() => ({ reply: vi.fn(async (_ctx: unknown, _text: string) => {}) }));

vi.mock('../shared', async (importOriginal) => {
  const actual = await importOriginal<typeof Shared>();
  return { ...actual, reply };
});

let dir: string;
let file: string;
let store: WorkSessionStore;

interface Ctx {
  ctx: CommandContext;
  interrupt: Mock;
}

function makeCtx(over: Partial<CommandContext> = {}): Ctx {
  const interrupt = vi.fn(() => false);
  const ctx = {
    scope: 'oc_1',
    workSessions: store,
    activeRuns: { interrupt },
    channel: { send: vi.fn(async () => {}) },
    msg: { chatId: 'oc_1', messageId: 'om_1' },
    chatMode: 'p2p',
    ...over,
  } as unknown as CommandContext;
  return { ctx, interrupt };
}

beforeEach(async () => {
  reply.mockClear();
  dir = await mkdtemp(join(tmpdir(), 'work-cmd-'));
  file = join(dir, 'sessions.json');
  store = new WorkSessionStore(file);
  await store.load();
});

afterEach(async () => {
  await store.flush();
  await rm(dir, { recursive: true, force: true });
});

describe('/work command', () => {
  it('names the next work session when a name is given', async () => {
    store.bindSegment('oc_1', 'sess-a', '/repo', { startedAtMs: 1, lastActiveAtMs: 1 });
    const { ctx } = makeCtx();

    await handleWork('会话重构', ctx);

    // The current work session is archived: the new one only appears once the
    // next message binds its first segment.
    expect(store.activeWorkSession('oc_1')).toBeUndefined();
    store.bindSegment('oc_1', 'sess-b', '/repo', { startedAtMs: 2, lastActiveAtMs: 2 });

    const active = store.activeWorkSession('oc_1');
    expect(active?.id).toBe('sess-b');
    expect(active?.title).toBe('会话重构');
    expect(reply).toHaveBeenCalledWith(ctx, expect.stringContaining('已开始新工作会话：'));
  });

  it('starts an unnamed work session and keeps the old one in history', async () => {
    store.bindSegment('oc_1', 'sess-a', '/repo', { startedAtMs: 1, lastActiveAtMs: 1 });
    store.setTitle('oc_1', '旧活');
    const { ctx } = makeCtx();

    await handleWork('', ctx);
    store.bindSegment('oc_1', 'sess-b', '/repo', { startedAtMs: 2, lastActiveAtMs: 2 });

    const active = store.activeWorkSession('oc_1');
    expect(active?.id).toBe('sess-b');
    // Unnamed: /history falls back to the last user message.
    expect(active?.title).toBeUndefined();
    // The old work session survives untouched.
    const old = store.workSessionById('sess-a');
    expect(old?.title).toBe('旧活');
    expect(old?.segments.map((s) => s.sessionId)).toEqual(['sess-a']);
    expect(reply).toHaveBeenCalledWith(ctx, expect.stringContaining('未命名'));
  });

  it('interrupts the running task in the scope', async () => {
    const { ctx, interrupt } = makeCtx();

    await handleWork('新活', ctx);

    expect(interrupt).toHaveBeenCalledWith('oc_1');
  });

  it('rejects an over-long name without touching the store', async () => {
    store.bindSegment('oc_1', 'sess-a', '/repo', { startedAtMs: 1, lastActiveAtMs: 1 });
    const before = store.allWorkSessions().map((w) => w.id);
    const { ctx, interrupt } = makeCtx();

    await handleWork('x'.repeat(61), ctx);

    expect(reply).toHaveBeenCalledWith(ctx, expect.stringContaining('过长'));
    expect(interrupt).not.toHaveBeenCalled();
    // Nothing archived, no active pointer moved, no pendingTitle written.
    expect(store.activeWorkSession('oc_1')?.id).toBe('sess-a');
    expect(store.allWorkSessions().map((w) => w.id)).toEqual(before);
    await store.flush();
    const onDisk = JSON.parse(await readFile(file, 'utf8')) as {
      scopes: Record<string, { pendingTitle?: string }>;
    };
    expect(onDisk.scopes['oc_1']?.pendingTitle).toBeUndefined();
  });

  it('accepts a name at exactly the 60-char limit', async () => {
    store.bindSegment('oc_1', 'sess-a', '/repo', { startedAtMs: 1, lastActiveAtMs: 1 });
    const name = 'x'.repeat(60);
    const { ctx } = makeCtx();

    await handleWork(name, ctx);
    store.bindSegment('oc_1', 'sess-b', '/repo', { startedAtMs: 2, lastActiveAtMs: 2 });

    expect(store.activeWorkSession('oc_1')?.title).toBe(name);
  });

  it('is registered as the /work command', () => {
    expect(handlers['/work']).toBe(handleWork);
  });
});
