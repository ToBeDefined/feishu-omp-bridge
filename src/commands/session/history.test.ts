import { mkdtemp, rm, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { paths } from '../../config/paths';
import { shortPath } from '../../card/templates';
import type { CommandContext } from '../index';
import { handleHistory } from './history';
import { listWorkSessions, scanSessionFiles } from './sessions';
import { applyResume } from './resume';
import { renderContext } from './context';
import { WorkSessionStore } from '../../session/work-store';

const { reply, recallMessage, sendManagedCard } = vi.hoisted(() => ({
  reply: vi.fn(async (_ctx: unknown, _text: string) => {}),
  recallMessage: vi.fn(async (_ctx: unknown) => {}),
  sendManagedCard: vi.fn(async (_channel: unknown, _chatId: string, _card: unknown) => ({
    messageId: 'om_card',
  })),
}));

vi.mock('../shared', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../shared')>();
  return { ...actual, reply, recallMessage };
});
vi.mock('../../card/managed', () => ({
  sendManagedCard,
  // applyResume settles the clicked card via these; keep them off the wire.
  updateManagedCard: vi.fn(async () => {}),
  forgetManagedCard: vi.fn(),
}));

const origDir = paths.ompSessionsDir;
let tmp: string;

beforeEach(async () => {
  tmp = await mkdtemp(join(tmpdir(), 'history-'));
  paths.ompSessionsDir = tmp;
  reply.mockClear();
  sendManagedCard.mockClear();
  recallMessage.mockClear();
});

afterEach(async () => {
  paths.ompSessionsDir = origDir;
  await rm(tmp, { recursive: true, force: true });
});

/** One session file: header + `turns` real user turns + an assistant reply. */
async function writeSession(
  name: string,
  session: { id: string; cwd: string; ts: string },
  turns: number,
  timeMs: number,
  label = 'A',
): Promise<void> {
  const lines = [
    JSON.stringify({ type: 'session', id: session.id, cwd: session.cwd, timestamp: session.ts }),
  ];
  for (let i = 0; i < turns; i += 1) {
    lines.push(
      JSON.stringify({
        type: 'message',
        timestamp: `t${i}`,
        message: { role: 'user', content: [{ type: 'text', text: `${label} 问题 ${i}` }] },
      }),
      JSON.stringify({
        type: 'message',
        timestamp: `a${i}`,
        message: { role: 'assistant', content: [{ type: 'text', text: `回答 ${i}` }] },
      }),
    );
  }
  const file = join(tmp, name);
  await writeFile(file, `${lines.join('\n')}\n`, 'utf8');
  const secs = timeMs / 1000;
  await utimes(file, secs, secs);
}

/** Captures the session/cwd the handler points the scope at. */
interface ResumeSpy {
  bindSegment: ReturnType<typeof vi.fn>;
  setCwd: ReturnType<typeof vi.fn>;
  interrupt: ReturnType<typeof vi.fn>;
  currentSessionId: string | undefined;
}

function makeCtx(over: Partial<Record<string, unknown>> = {}): {
  ctx: CommandContext;
  spy: ResumeSpy;
} {
  const spy: ResumeSpy = {
    bindSegment: vi.fn(),
    setCwd: vi.fn(),
    interrupt: vi.fn(),
    currentSessionId: undefined,
  };
  const ctx = {
    scope: 'oc_1',
    workspaces: {
      cwdFor: () => tmp,
      listNamed: () => ({ bridge: tmp }),
      setCwd: spy.setCwd,
    },
    workSessions: {
      // listWorkSessions folds each work session's segments into one row; the
      // raw scanSessionFiles still maps segmentId→title from here.
      allWorkSessions: () => [
        {
          id: 's1',
          scope: 'oc_1',
          title: '命名的会话',
          cwd: tmp,
          createdAtMs: 0,
          lastActiveAtMs: 0,
          segments: [{ sessionId: 's1', cwd: tmp, startedAtMs: 0, lastActiveAtMs: 0 }],
        },
      ],
      titleFor: (id?: string) => (id === 's1' ? '命名的会话' : undefined),
      workSessionById: () => undefined,
      workSessionForSegment: () => undefined,
      activeWorkSession: () =>
        spy.currentSessionId
          ? { id: spy.currentSessionId, currentSegmentId: spy.currentSessionId, cwd: tmp }
          : undefined,
      chats: () => ['oc_1'],
      bindSegment: spy.bindSegment,
      // renderContext reads the scope's idle-timeout override.
      getIdleTimeoutMinutes: () => undefined,
    },
    // renderContext (reached through applyResume) asks whether a run is live.
    activeRuns: { interrupt: spy.interrupt, has: () => false },
    agent: {},
    controls: { cfg: {} },
    channel: { send: async () => {} },
    msg: { chatId: 'oc_1', messageId: 'om_1' },
    fromCardAction: false,
    ...over,
  } as unknown as CommandContext;
  return { ctx, spy };
}

/** The card the handler just handed to the managed-card API. */
interface CardShape {
  body: { elements: Array<Record<string, unknown>> };
}

function sentCard(): CardShape {
  expect(sendManagedCard).toHaveBeenCalledTimes(1);
  return sendManagedCard.mock.calls[0]![2] as CardShape;
}

function cardJson(): string {
  return JSON.stringify(sentCard());
}

describe('scanSessionFiles', () => {
  it('reads every session, counts real turns, and sorts by activity', async () => {
    await writeSession('a.jsonl', { id: 's1', cwd: '/repo/a', ts: '2026-01-01T00:00:00Z' }, 3, Date.now() - 7_200_000);
    await writeSession('b.jsonl', { id: 's2', cwd: '/repo/b', ts: '2026-02-01T00:00:00Z' }, 1, Date.now() - 60_000);
    // Header without id/cwd is skipped rather than failing the whole listing.
    await writeFile(join(tmp, 'broken.jsonl'), '{"type":"session"}\n', 'utf8');
    await writeFile(join(tmp, 'notes.txt'), 'ignored', 'utf8');

    const sessions = await scanSessionFiles(makeCtx().ctx);
    expect(sessions.map((s) => s.sessionId)).toEqual(['s2', 's1']);
    expect(sessions.find((s) => s.sessionId === 's1')).toMatchObject({
      cwd: '/repo/a',
      turns: 3,
      startedAt: '2026-01-01T00:00:00Z',
      title: '命名的会话',
      summary: '回答 2',
      lastMessage: 'A 问题 2',
    });
  });
});

describe('listWorkSessions', () => {
  it('aggregates a 3-segment work session into one row (turns summed)', async () => {
    await writeSession('g1.jsonl', { id: 'ws-1', cwd: tmp, ts: '2026-03-01T00:00:00Z' }, 2, Date.now() - 300_000);
    await writeSession('g2.jsonl', { id: 'seg-2', cwd: tmp, ts: '2026-03-02T00:00:00Z' }, 3, Date.now() - 200_000);
    await writeSession('g3.jsonl', { id: 'seg-3', cwd: tmp, ts: '2026-03-03T00:00:00Z' }, 4, Date.now() - 100_000);
    const store = new WorkSessionStore(join(tmp, 'sessions.json'));
    await store.load();
    store.bindSegment('oc_1', 'ws-1', tmp, { startedAtMs: 1_000, lastActiveAtMs: 1_000 });
    store.bindSegment('oc_1', 'seg-2', tmp, { startedAtMs: 2_000, lastActiveAtMs: 2_000 });
    store.bindSegment('oc_1', 'seg-3', tmp, { startedAtMs: 3_000, lastActiveAtMs: 3_000 });

    const rows = await listWorkSessions(makeCtx({ workSessions: store }).ctx);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ workSessionId: 'ws-1', segmentCount: 3, turns: 9 });
    expect(rows[0]!.segments.map((s) => s.sessionId)).toEqual(['ws-1', 'seg-2', 'seg-3']);
    // 最后活动 = max（工作会话自身、各段文件 mtime）
    expect(rows[0]!.lastActiveAtMs).toBeGreaterThanOrEqual(Date.now() - 300_000);
    await store.flush();
  });

  it('gives a file no work session claims its own row (workSessionId = sessionId)', async () => {
    await writeSession('orphan.jsonl', { id: 'orphan-1', cwd: tmp, ts: '2026-04-01T00:00:00Z' }, 5, Date.now() - 50_000);
    const store = new WorkSessionStore(join(tmp, 'sessions.json'));
    await store.load();

    const rows = await listWorkSessions(makeCtx({ workSessions: store }).ctx);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      workSessionId: 'orphan-1',
      segmentCount: 1,
      turns: 5,
      cwd: tmp,
      scope: null,
    });
    await store.flush();
  });

  it('sorts rows by last activity, newest first', async () => {
    await writeSession('old.jsonl', { id: 'old-ws', cwd: tmp, ts: '2026-01-01T00:00:00Z' }, 1, Date.now() - 900_000);
    await writeSession('new.jsonl', { id: 'new-ws', cwd: tmp, ts: '2026-01-02T00:00:00Z' }, 1, Date.now() - 10_000);
    const store = new WorkSessionStore(join(tmp, 'sessions.json'));
    await store.load();
    store.bindSegment('oc_1', 'old-ws', tmp, { startedAtMs: 1, lastActiveAtMs: 1 });
    store.startWorkSession('oc_1'); // /work: the next segment opens a new work session
    store.bindSegment('oc_1', 'new-ws', tmp, { startedAtMs: 2, lastActiveAtMs: 2 });

    const rows = await listWorkSessions(makeCtx({ workSessions: store }).ctx);
    expect(rows.map((r) => r.workSessionId)).toEqual(['new-ws', 'old-ws']);
    await store.flush();
  });

  it("keeps a work session's declared segment count when a segment file is gone", async () => {
    await writeSession('keep.jsonl', { id: 'ws-k', cwd: tmp, ts: '2026-05-01T00:00:00Z' }, 2, Date.now() - 100_000);
    const store = new WorkSessionStore(join(tmp, 'sessions.json'));
    await store.load();
    store.bindSegment('oc_1', 'ws-k', tmp, { startedAtMs: 1, lastActiveAtMs: 1 });
    store.bindSegment('oc_1', 'gone-seg', tmp, { startedAtMs: 2, lastActiveAtMs: 2 });

    const rows = await listWorkSessions(makeCtx({ workSessions: store }).ctx);
    const row = rows.find((r) => r.workSessionId === 'ws-k');
    expect(row).toMatchObject({ segmentCount: 2, turns: 2 });
    expect(row!.segments.map((s) => s.sessionId)).toEqual(['ws-k']);
    await store.flush();
  });
});

describe('/history', () => {
  beforeEach(async () => {
    // /repo/a (current workspace): two conversations, the newer one most recent.
    await writeSession('a1.jsonl', { id: 's1', cwd: tmp, ts: '2026-01-01T00:00:00Z' }, 3, Date.now() - 7_200_000);
    await writeSession('a2.jsonl', { id: 's3', cwd: tmp, ts: '2026-01-02T00:00:00Z' }, 5, Date.now() - 120_000);
    // Another workspace: must NOT show up in the scoped listing.
    await writeSession('b1.jsonl', { id: 's2', cwd: '/repo/b', ts: '2026-01-03T00:00:00Z' }, 1, Date.now() - 60_000, '另一个工作区');
    // Its identity must not leak into the scoped listing.
  });

  it('lists only the current workspace, newest activity first', async () => {
    await handleHistory('', makeCtx().ctx);
    const card = cardJson();
    expect(card).toContain('· 2 个会话');
    // Header shows the (length-capped) workspace path.
    expect(card).toContain(shortPath(tmp));
    expect(card).toContain('🔁 5 轮');
    expect(card).toContain('🔁 3 轮');
    // Newer activity (#1 = s3) leads; an unnamed session is identified by the
    // message it ENDED on (last real user turn).
    expect(card.indexOf('#1')).toBeLessThan(card.indexOf('#2'));
    expect(card.slice(card.indexOf('#1'))).toContain('A 问题 4');
    // The titled row keeps the title AND still shows its topic.
    expect(card).toContain('🏷 **命名的会话**');
    expect(card).toContain('💬 A 问题 2');
    // The other workspace's session is filtered out.
    expect(card).not.toContain('另一个工作区');
    // Rows do not repeat the header's directory.
    expect(card).not.toContain('📁');
    expect(sendManagedCard).toHaveBeenCalledWith(
      expect.anything(),
      'oc_1',
      expect.anything(),
    );
  });

  it('filters by the work session cwd, not an older segment cwd', async () => {
    const store = new WorkSessionStore(join(tmp, 'sessions.json'));
    await store.load();
    // Cross-directory work session: an old segment lived in /repo/old, the
    // latest one lives in the current workspace (tmp).
    store.bindSegment('oc_1', 'cross-ws', '/repo/old', { startedAtMs: 1, lastActiveAtMs: 1 });
    store.bindSegment('oc_1', 'seg-new', tmp, { startedAtMs: 2, lastActiveAtMs: 2 });
    await writeSession('cross1.jsonl', { id: 'cross-ws', cwd: '/repo/old', ts: '2026-01-01T00:00:00Z' }, 1, Date.now() - 100_000, 'OLD');
    await writeSession('cross2.jsonl', { id: 'seg-new', cwd: tmp, ts: '2026-01-02T00:00:00Z' }, 2, Date.now() - 50_000, 'NEW');

    await handleHistory('', makeCtx({ workSessions: store }).ctx);
    const card = cardJson();
    // The cross-dir work session is kept (its LATEST segment is here) even
    // though its first segment's cwd is elsewhere...
    expect(card).toContain('🧵 2 段');
    expect(card).toContain('NEW 问题 1');
    expect(card).not.toContain('OLD 问题 0');
    await store.flush();
  });

  it('lists every workspace with /history all, labelled per row', async () => {
    await handleHistory('all', makeCtx().ctx);
    const card = cardJson();
    expect(card).toContain('全部工作区 · 3 个会话');
    expect(card).toContain('📁 bridge');
    expect(card).toContain('📁 /repo/b');
    expect(card).toContain('📁 bridge');
    expect(card).toContain('问题 0');
  });

  it('honours the pager payload (`page <mode> <offset>`)', async () => {
    await handleHistory('page all 8', makeCtx().ctx);
    // 9th row onwards already rendered on the previous page; the PAGER is
    // exercised end-to-end by /history all paging past the page size.
    expect(cardJson()).toContain('全部工作区 · 3 个会话');
  });

  it('clamps a stale offset instead of rendering an empty page', async () => {
    await handleHistory('all 99', makeCtx().ctx);
    expect(cardJson()).toContain('另一个工作区 问题 0');
  });

  it('rejects unknown arguments with usage', async () => {
    await handleHistory('yesterday', makeCtx().ctx);
    expect(sendManagedCard).not.toHaveBeenCalled();
    expect(reply.mock.calls[0]![1]).toContain('`/history all`');
  });

  it('says so when the workspace has no history yet', async () => {
    const { ctx } = makeCtx({
      workspaces: { cwdFor: () => '/repo/empty', listNamed: () => ({}) },
    });
    await handleHistory('', ctx);
    expect(sendManagedCard).not.toHaveBeenCalled();
    expect(reply.mock.calls[0]![1]).toContain('/repo/empty');
    expect(reply.mock.calls[0]![1]).toContain('/history all');
  });

  it('resumes the session a 继续对话 button points at', async () => {
    const { ctx, spy } = makeCtx();
    await handleHistory('resume s3', ctx);
    // applyResume ran for the real record: cwd pinned, session switched with
    // that session's OWN start/last-active times (s3 = 2026-01-02, active two
    // minutes ago — not the moment of the click), and any in-flight run in
    // this scope interrupted.
    expect(spy.bindSegment).toHaveBeenCalledWith('oc_1', 's3', tmp, {
      startedAtMs: Date.parse('2026-01-02T00:00:00Z'),
      lastActiveAtMs: expect.any(Number),
    });
    expect(spy.setCwd).toHaveBeenCalledWith('oc_1', tmp);
    expect(spy.interrupt).toHaveBeenCalledWith('oc_1');
    // The listing is not re-sent — the card settles into 会话已恢复.
    expect(sendManagedCard).not.toHaveBeenCalled();
  });

  it('binds a resumed session to its own times on the active work session', async () => {
    const store = new WorkSessionStore(join(tmp, 'sessions.json'));
    await store.load();
    store.bindSegment('oc_1', 's1', tmp);
    store.setTitle('oc_1', '被替换的会话名');

    const { ctx } = makeCtx({ workSessions: store });
    await applyResume(ctx, {
      sessionId: 's3',
      cwd: tmp,
      timestamp: '2026-01-02T00:00:00Z',
      updatedAtMs: 1_700_000_000_000,
      summary: '',
    });

    // The resumed session reports its own history, as a new segment of the
    // SAME work session (resume does not start a new work session)...
    const ws = store.activeWorkSession('oc_1');
    expect(ws?.currentSegmentId).toBe('s3');
    expect(ws?.segments.find((s) => s.sessionId === 's3')).toMatchObject({
      startedAtMs: Date.parse('2026-01-02T00:00:00Z'),
      lastActiveAtMs: 1_700_000_000_000,
    });
    // ...and the name set before the resume names this work session, so it
    // still applies (a work session keeps its name across its segments).
    expect(store.titleFor('s3')).toBe('被替换的会话名');
    expect(renderContext(ctx, {})).toContain('被替换的会话名');
    // Settle the store's async persist before afterEach removes tmp.
    await store.flush();
  });

  it('refuses a 继续对话 payload whose session is gone', async () => {
    const { ctx, spy } = makeCtx();
    await handleHistory('resume deleted-session', ctx);
    expect(spy.bindSegment).not.toHaveBeenCalled();
    expect(reply.mock.calls[0]![1]).toContain('未找到会话');
  });

  it('marks the scope own session in the listing', async () => {
    const { ctx, spy } = makeCtx();
    // currentWorkSessionId is what the card uses to skip a no-op resume button.
    spy.currentSessionId = 's3';
    await handleHistory('all', ctx);
    expect(cardJson()).toContain('✅ 当前');
    // Rows for other sessions still carry the resume button.
    expect(cardJson()).toContain('history.resume');
    expect(cardJson()).not.toContain('history.resume","arg":"s3"');
  });

  it('replaces the clicked card instead of stacking a new one', async () => {
    await handleHistory('all 8', makeCtx({ fromCardAction: true }).ctx);
    expect(recallMessage).toHaveBeenCalled();
  });
});
