import { mkdir, mkdtemp, rm, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import { paths } from '../../config/paths';
import type { CommandContext } from '../index';
import { applyResume, listResumableSessions, resumeHandlers } from './resume';
import { listWorkSessions, pickActiveSegment } from './sessions';
import { handleHistory } from './history';
import { loadSessionSummary, renderContext } from './context';
import { WorkSessionStore } from '../../session/work-store';

const { reply } = vi.hoisted(() => ({
  reply: vi.fn(async (_ctx: unknown, _text: string) => {}),
}));

vi.mock('../shared', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../shared')>();
  return { ...actual, reply, recallMessage: vi.fn(async () => {}) };
});
vi.mock('../../card/managed', () => ({
  sendManagedCard: vi.fn(async () => ({ messageId: 'om_card' })),
  updateManagedCard: vi.fn(async () => {}),
  forgetManagedCard: vi.fn(),
}));
// Wrap loadSessionSummary so the "renderContext must not rescan" contract is
// observable, while every real code path still reads real files.
vi.mock('./context', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./context')>();
  return { ...actual, loadSessionSummary: vi.fn(actual.loadSessionSummary) };
});

const origDir = paths.ompSessionsDir;
let tmp: string;

beforeEach(async () => {
  tmp = await mkdtemp(join(tmpdir(), 'resume-'));
  paths.ompSessionsDir = tmp;
  vi.mocked(loadSessionSummary).mockClear();
  reply.mockClear();
});

afterEach(async () => {
  paths.ompSessionsDir = origDir;
  await rm(tmp, { recursive: true, force: true });
});

async function dir(name: string): Promise<string> {
  const p = join(tmp, name);
  await mkdir(p, { recursive: true });
  return p;
}

/** One session file: header + `turns` real user turns + an assistant reply. */
async function writeSession(
  sessionId: string,
  cwd: string,
  turns = 1,
  timeMs = Date.now(),
  label = 'MSG',
): Promise<void> {
  const lines = [
    JSON.stringify({ type: 'session', id: sessionId, cwd, timestamp: '2026-01-01T00:00:00Z' }),
  ];
  for (let i = 0; i < turns; i += 1) {
    lines.push(
      JSON.stringify({
        type: 'message',
        message: { role: 'user', content: [{ type: 'text', text: `${label} 问题 ${i}` }] },
      }),
      JSON.stringify({
        type: 'message',
        message: { role: 'assistant', content: [{ type: 'text', text: `回答 ${i}` }] },
      }),
    );
  }
  const file = join(tmp, `${sessionId}.jsonl`);
  await writeFile(file, `${lines.join('\n')}\n`, 'utf8');
  const secs = timeMs / 1000;
  await utimes(file, secs, secs);
}

async function openStore(): Promise<WorkSessionStore> {
  const store = new WorkSessionStore(join(tmp, 'sessions.json'));
  await store.load();
  return store;
}

interface CtxSpy {
  ctx: CommandContext;
  setCwd: Mock;
  interrupt: Mock;
}

function makeCtx(store: WorkSessionStore, over: Record<string, unknown> = {}): CtxSpy {
  const setCwd = vi.fn();
  const interrupt = vi.fn();
  const ctx = {
    scope: 'oc_1',
    chatMode: 'p2p',
    workspaces: { cwdFor: () => tmp, listNamed: () => ({}), setCwd },
    workSessions: store,
    activeRuns: { interrupt, has: () => false },
    agent: {},
    controls: { cfg: {} },
    channel: { send: async () => {} },
    msg: { chatId: 'oc_1', messageId: 'om_1' },
    fromCardAction: false,
    ...over,
  } as unknown as CommandContext;
  return { ctx, setCwd, interrupt };
}

describe('pickActiveSegment', () => {
  it('returns the conversation while its file is alive, else nothing', async () => {
    const store = await openStore();
    store.bindSegment('oc_1', 's1', '/repo');
    const ws = store.workSessionById('s1')!;
    expect(pickActiveSegment(ws, () => true)?.sessionId).toBe('s1');
    // 文件被删（幽灵对话）：没有可恢复的段。
    expect(pickActiveSegment(ws, () => false)).toBeUndefined();
    await store.flush();
  });
});

describe('applyResume adopting a work session', () => {
  it('claims a scope:null history work session for the current chat', async () => {
    const a = await dir('a');
    await writeSession('legacy-ws', a);
    await writeFile(
      join(tmp, 'sessions.json'),
      JSON.stringify({
        v: 2,
        scopes: {},
        workSessions: {
          'legacy-ws': {
            id: 'legacy-ws',
            scope: null,
            cwd: a,
            createdAtMs: 1,
            lastActiveAtMs: 1,
            currentSegmentId: 'legacy-ws',
            segments: [{ sessionId: 'legacy-ws', cwd: a, startedAtMs: 1, lastActiveAtMs: 1 }],
          },
        },
      }),
      'utf8',
    );
    const store = await openStore();
    const { ctx } = makeCtx(store, { scope: 'oc_1' });

    await applyResume(ctx, {
      workSessionId: 'legacy-ws',
      sessionId: 'legacy-ws',
      cwd: a,
      timestamp: new Date(1).toISOString(),
    });

    expect(store.workSessionById('legacy-ws')?.scope).toBe('oc_1');
    expect(store.activeWorkSession('oc_1')?.id).toBe('legacy-ws');
    await store.flush();
  });

  it('refuses when another scope currently holds a segment of the work session', async () => {
    const a = await dir('a');
    await writeSession('ws-x', a);
    const store = await openStore();
    store.bindSegment('oc_1', 'ws-x', a, { startedAtMs: 1, lastActiveAtMs: 1 }); // oc_1 is using it

    const { ctx, setCwd, interrupt } = makeCtx(store, { scope: 'oc_2' });
    await applyResume(ctx, {
      workSessionId: 'ws-x',
      sessionId: 'ws-x',
      cwd: a,
      timestamp: new Date(1).toISOString(),
    });

    expect(store.activeWorkSession('oc_2')).toBeUndefined();
    expect(setCwd).not.toHaveBeenCalled();
    expect(interrupt).not.toHaveBeenCalled();
    expect(reply.mock.calls[0]![1]).toContain('占用');
    await store.flush();
  });

  it('未认领的历史文件：开它自己的工作会话，时间取会话文件', async () => {
    const a = await dir('a');
    await writeSession('legacy', a);
    const store = await openStore(); // no work session claims 'legacy'
    const { ctx, setCwd, interrupt } = makeCtx(store, { scope: 'oc_1' });

    await applyResume(ctx, {
      sessionId: 'legacy',
      cwd: a,
      timestamp: new Date(1000).toISOString(),
      updatedAtMs: 4242,
    });

    const active = store.activeWorkSession('oc_1');
    expect(active?.id).toBe('legacy');
    expect(active?.segments.map((s) => s.sessionId)).toEqual(['legacy']);
    // Times come from the session file (match payload), not `now`.
    expect(active?.segments[0]?.startedAtMs).toBe(1000);
    expect(active?.segments[0]?.lastActiveAtMs).toBe(4242);
    expect(setCwd).toHaveBeenCalledWith('oc_1', a);
    expect(interrupt).toHaveBeenCalledWith('oc_1');
    await store.flush();
  });

  it('继续无归属历史：不挂进当前活跃工作会话，也不顶着它的标题', async () => {
    const a = await dir('a');
    await writeSession('legacy', a);
    const store = await openStore();
    // The chat is in the middle of another piece of work, with a name.
    store.bindSegment('oc_1', 'current-work', a, { startedAtMs: 10, lastActiveAtMs: 10 });
    store.setTitle('oc_1', '更新 UI 效果以及扩展功能');
    const { ctx } = makeCtx(store, { scope: 'oc_1' });

    // /history 继续对话 on the unclaimed conversation's row.
    await applyResume(ctx, {
      sessionId: 'legacy',
      cwd: a,
      timestamp: new Date(1000).toISOString(),
      updatedAtMs: 4242,
    });

    const active = store.activeWorkSession('oc_1');
    expect(active?.id).toBe('legacy');
    expect(active?.title).toBeUndefined();
    // The other work session keeps its segment... and its name.
    expect(store.workSessionById('current-work')?.segments.map((s) => s.sessionId)).toEqual([
      'current-work',
    ]);
    const text = renderContext(ctx, {});
    expect(text).toContain('`legacy`');
    expect(text).not.toContain('更新 UI 效果以及扩展功能');
    await store.flush();
  });
});

describe('applyResume refuses a ghost work session (every segment file gone)', () => {
  /** Store lists two segments, but neither OMP session file is written. */
  async function ghostStore(): Promise<WorkSessionStore> {
    const a = await dir('a');
    const store = await openStore();
    store.bindSegment('oc_1', 'seg-x', a, { startedAtMs: 1, lastActiveAtMs: 1 });
    store.bindSegment('oc_1', 'seg-y', a, { startedAtMs: 2, lastActiveAtMs: 2 }); // current = seg-y
    store.startWorkSession('oc_1'); // archived: another chat may resume it
    return store;
  }

  it('via /resume: refuses and does not adopt', async () => {
    const store = await ghostStore();
    const { ctx, setCwd, interrupt } = makeCtx(store, { scope: 'oc_2' });
    reply.mockClear();

    await applyResume(ctx, {
      workSessionId: 'seg-x',
      sessionId: 'seg-y',
      cwd: store.workSessionById('seg-x')!.cwd,
      timestamp: new Date(1).toISOString(),
    });

    expect(reply.mock.calls[0]![1]).toContain('会话文件已不存在');
    expect(reply.mock.calls[0]![1]).toContain('无法恢复');
    expect(store.activeWorkSession('oc_2')).toBeUndefined();
    expect(setCwd).not.toHaveBeenCalled();
    expect(interrupt).not.toHaveBeenCalled();
    await store.flush();
  });

  it('via /history 继续对话: refuses and does not adopt', async () => {
    const store = await ghostStore();
    const { ctx } = makeCtx(store, { scope: 'oc_2' });
    reply.mockClear();

    await handleHistory('resume seg-x', ctx);

    expect(reply.mock.calls[0]![1]).toContain('无法恢复');
    expect(store.activeWorkSession('oc_2')).toBeUndefined();
    await store.flush();
  });
});

describe('/history topic and 继续对话 resume the same segment', () => {
  it('current segment ≠ latest segment: both pick the current one', async () => {
    const a = await dir('a');
    const b = await dir('b');
    await writeSession('seg-a', a, 1, Date.now() - 1000, 'SEGA');
    await writeSession('seg-b', b, 1, Date.now() - 500, 'SEGB');
    const store = await openStore();
    store.bindSegment('oc_1', 'seg-a', a, { startedAtMs: 1, lastActiveAtMs: 1 });
    store.bindSegment('oc_1', 'seg-b', b, { startedAtMs: 2, lastActiveAtMs: 2 });
    store.bindSegment('oc_1', 'seg-a', a, { startedAtMs: 1, lastActiveAtMs: 3 }); // current = seg-a
    store.startWorkSession('oc_1'); // archived: resumable from another chat

    const { ctx } = makeCtx(store, { scope: 'oc_9' });
    const row = (await listWorkSessions(ctx)).find((r) => r.workSessionId === 'seg-a')!;
    expect(row.topic).toBe('SEGA 问题 0');
    expect(row.topic).not.toBe('SEGB 问题 0');

    await applyResume(ctx, {
      workSessionId: 'seg-a',
      sessionId: row.activeSegmentId ?? 'seg-a',
      cwd: row.cwd,
      timestamp: '',
    });
    // The button restores exactly the segment the row described, not the latest.
    expect(store.activeWorkSession('oc_9')?.currentSegmentId).toBe('seg-a');
    await store.flush();
  });

  it('current segment file deleted: both fall back to the latest surviving one', async () => {
    const a = await dir('a');
    const b = await dir('b');
    await writeSession('seg-x', a, 1, Date.now() - 1000, 'SEGX');
    // seg-y's file is deliberately never written.
    const store = await openStore();
    store.bindSegment('oc_1', 'seg-x', a, { startedAtMs: 1, lastActiveAtMs: 1 });
    store.bindSegment('oc_1', 'seg-y', b, { startedAtMs: 2, lastActiveAtMs: 2 }); // current = seg-y

    const { ctx } = makeCtx(store, { scope: 'oc_1' });
    const row = (await listWorkSessions(ctx)).find((r) => r.workSessionId === 'seg-x')!;
    expect(row.activeSegmentId).toBe('seg-x');
    expect(row.topic).toBe('SEGX 问题 0');

    await applyResume(ctx, {
      workSessionId: 'seg-x',
      sessionId: row.activeSegmentId ?? 'seg-x',
      cwd: row.cwd,
      timestamp: '',
    });
    expect(store.activeWorkSession('oc_1')?.currentSegmentId).toBe('seg-x');
    await store.flush();
  });
});

describe('listResumableSessions', () => {
  it('lists one row per OMP session (one session = one conversation)', async () => {
    const a = await dir('a');
    await writeSession('s1', a, 1, Date.now() - 1000);
    await writeSession('s2', a, 1, Date.now() - 500);
    const store = await openStore();
    store.bindSegment('oc_1', 's1', a, { startedAtMs: 1, lastActiveAtMs: 1 });
    store.bindSegment('oc_1', 's2', a, { startedAtMs: 2, lastActiveAtMs: 2 });
    store.startWorkSession('oc_1'); // archived: no chat currently holds it

    const { ctx } = makeCtx(store, { scope: 'oc_9' });
    const options = await listResumableSessions(ctx);
    // 两段会话 = 两个可恢复的对话，各自带着自己的 id。
    expect(options.map((o) => o.sessionId).sort()).toEqual(['s1', 's2']);
    expect(options.every((o) => o.segmentCount === 1)).toBe(true);
    await store.flush();
  });
});

describe('renderContext', () => {
  it('does not rescan the session dir when a summary is passed in', async () => {
    const store = await openStore();
    const { ctx } = makeCtx(store);
    vi.mocked(loadSessionSummary).mockClear();
    renderContext(ctx, { lastMessage: '外部传入', lastReply: '外部回复' });
    expect(loadSessionSummary).not.toHaveBeenCalled();
    await store.flush();
  });
});

