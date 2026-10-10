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
    // 名字包在反引号里（与 /rename 一致）。
    expect(reply).toHaveBeenCalledWith(ctx, expect.stringContaining('`会话重构`'));
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

describe('/work merge', () => {
  async function twoWorkSessions(): Promise<void> {
    store.bindSegment('oc_1', 'sess-a', '/repo', { startedAtMs: 1, lastActiveAtMs: 1 });
    store.setTitle('oc_1', '旧活');
    store.startWorkSession('oc_1');
    store.bindSegment('oc_1', 'sess-b', '/repo', { startedAtMs: 2, lastActiveAtMs: 2 });
    await store.flush();
  }

  it('folds the second id into the first and reports the merged segment count', async () => {
    await twoWorkSessions();
    const { ctx } = makeCtx();

    await handleWork('merge sess-a sess-b', ctx);

    expect(store.workSessionById('sess-b')).toBeUndefined();
    expect(store.workSessionById('sess-a')?.segments.map((s) => s.sessionId)).toEqual([
      'sess-a',
      'sess-b',
    ]);
    expect(store.activeWorkSession('oc_1')?.id).toBe('sess-a');
    expect(reply).toHaveBeenCalledWith(ctx, expect.stringContaining('已把'));
    expect(reply).toHaveBeenCalledWith(ctx, expect.stringContaining('共 2 段'));
  });

  it('infers the earlier work session when only one id is given', async () => {
    await twoWorkSessions();
    const { ctx } = makeCtx();

    await handleWork('merge sess-b', ctx);

    expect(store.workSessionById('sess-b')).toBeUndefined();
    // sess-b's seed was folded INTO the earlier sess-a.
    expect(store.workSessionById('sess-a')?.segments.map((s) => s.sessionId)).toEqual([
      'sess-a',
      'sess-b',
    ]);
  });

  it('reports a missing id', async () => {
    await twoWorkSessions();
    const { ctx } = makeCtx();

    await handleWork('merge sess-a nope', ctx);

    expect(reply).toHaveBeenCalledWith(ctx, expect.stringContaining('找不到工作会话'));
    expect(store.workSessionById('sess-b')).toBeDefined();
  });

  it('rejects a work session owned by another chat', async () => {
    store.bindSegment('oc_2', 'foreign', '/repo', { startedAtMs: 1, lastActiveAtMs: 1 });
    await twoWorkSessions();
    const { ctx } = makeCtx();

    await handleWork('merge sess-a foreign', ctx);

    expect(reply).toHaveBeenCalledWith(ctx, expect.stringContaining('不是当前会话的工作会话'));
    expect(store.workSessionById('foreign')).toBeDefined();
  });

  it('refuses to merge a work session into itself', async () => {
    await twoWorkSessions();
    const { ctx } = makeCtx();

    await handleWork('merge sess-a sess-a', ctx);

    expect(reply).toHaveBeenCalledWith(ctx, expect.stringContaining('不能把工作会话并入自己'));
  });

  it('shows usage when no id is given', async () => {
    await twoWorkSessions();
    const { ctx } = makeCtx();

    await handleWork('merge', ctx);

    expect(reply).toHaveBeenCalledWith(ctx, expect.stringContaining('用法'));
  });

  it('hints that merge/split are reserved when a work name is mistaken for an id', async () => {
    await twoWorkSessions();
    const { ctx } = makeCtx();

    // `/work merge 联调` reads like naming a work session "merge 联调", but the
    // first token is dispatched as the merge subcommand with id 联调.
    await handleWork('merge 联调', ctx);

    expect(reply).toHaveBeenCalledWith(ctx, expect.stringContaining('找不到工作会话'));
    expect(reply).toHaveBeenCalledWith(ctx, expect.stringContaining('保留子命令'));
  });

  it('asks for an active work session first', async () => {
    const { ctx } = makeCtx(); // fresh store: nothing bound

    await handleWork('merge a b', ctx);

    expect(reply).toHaveBeenCalledWith(ctx, expect.stringContaining('没有活跃的工作会话'));
  });
});

describe('/work split', () => {
  async function threeSegments(): Promise<void> {
    store.bindSegment('oc_1', 'sess-a', '/repo', { startedAtMs: 1, lastActiveAtMs: 1 });
    store.dropCurrentSegment('oc_1');
    store.bindSegment('oc_1', 'sess-b', '/other', { startedAtMs: 2, lastActiveAtMs: 2 });
    store.dropCurrentSegment('oc_1');
    store.bindSegment('oc_1', 'sess-c', '/repo', { startedAtMs: 3, lastActiveAtMs: 3 });
    await store.flush();
  }

  it('cuts from the given 1-based segment index into a new work session', async () => {
    await threeSegments();
    const { ctx } = makeCtx();

    await handleWork('split sess-a 2', ctx);

    expect(store.workSessionById('sess-a')?.segments.map((s) => s.sessionId)).toEqual(['sess-a']);
    expect(store.workSessionById('sess-b')?.segments.map((s) => s.sessionId)).toEqual([
      'sess-b',
      'sess-c',
    ]);
    expect(reply).toHaveBeenCalledWith(ctx, expect.stringContaining('切出新工作会话'));
  });

  it('rejects the first segment as a cut point', async () => {
    await threeSegments();
    const { ctx } = makeCtx();

    await handleWork('split sess-a 1', ctx);

    expect(reply).toHaveBeenCalledWith(ctx, expect.stringContaining('段序号无效'));
    expect(store.workSessionById('sess-b')).toBeUndefined();
  });

  it('rejects an out-of-range segment index', async () => {
    await threeSegments();
    const { ctx } = makeCtx();

    await handleWork('split sess-a 9', ctx);

    expect(reply).toHaveBeenCalledWith(ctx, expect.stringContaining('段序号无效'));
  });

  it('reports a missing work session and a foreign one', async () => {
    store.bindSegment('oc_2', 'foreign', '/repo', { startedAtMs: 1, lastActiveAtMs: 1 });
    await threeSegments();
    const { ctx } = makeCtx();

    await handleWork('split nope 2', ctx);
    expect(reply).toHaveBeenCalledWith(ctx, expect.stringContaining('找不到工作会话'));

    reply.mockClear();
    await handleWork('split foreign 2', ctx);
    expect(reply).toHaveBeenCalledWith(ctx, expect.stringContaining('不是当前会话的工作会话'));
  });

  it('asks for an active work session first', async () => {
    const { ctx } = makeCtx();

    await handleWork('split a 2', ctx);

    expect(reply).toHaveBeenCalledWith(ctx, expect.stringContaining('没有活跃的工作会话'));
  });

  it('lists merge/split as reserved words in the usage error', async () => {
    await threeSegments();
    const { ctx } = makeCtx();

    await handleWork('split', ctx);

    expect(reply).toHaveBeenCalledWith(ctx, expect.stringContaining('用法'));
    expect(reply).toHaveBeenCalledWith(ctx, expect.stringMatching(/merge[\s\S]*split/));
  });
});
