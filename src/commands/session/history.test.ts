import { mkdtemp, rm, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import { paths } from '../../config/paths';
import { shortPath } from '../../card/templates';
import type { CommandContext } from '../index';
import { handleHistory } from './history';
import { scanSessionFiles } from './sessions';
import { applyResume } from './resume';
import { renderContext } from './context';
import { SessionStore } from '../../session/store';

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
const stores: SessionStore[] = [];

beforeEach(async () => {
  tmp = await mkdtemp(join(tmpdir(), 'history-'));
  paths.ompSessionsDir = tmp;
  reply.mockClear();
  sendManagedCard.mockClear();
  recallMessage.mockClear();
});

afterEach(async () => {
  await Promise.all(stores.map((s) => s.flush()));
  stores.length = 0;
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

/** A fresh tmp-backed store, tracked so afterEach can settle its async writes. */
function makeStore(): SessionStore {
  const store = new SessionStore(join(tmp, 'sessions.json'));
  stores.push(store);
  return store;
}

/** Captures the cwd/interrupt the handler points the scope at. */
interface ResumeSpy {
  setCwd: Mock;
  interrupt: Mock;
}

function makeCtx(over: Partial<Record<string, unknown>> = {}): {
  ctx: CommandContext;
  spy: ResumeSpy;
  store: SessionStore;
} {
  const override = over.sessions as SessionStore | undefined;
  const store = override ?? makeStore();
  if (override === undefined) {
    // Default listing fixture: one named conversation (s1) owned by another
    // scope, so the default oc_1 scope has no current session.
    store.bind('oc_other', 's1', tmp);
    store.setTitle('oc_other', '命名的会话');
  }
  const spy: ResumeSpy = { setCwd: vi.fn(), interrupt: vi.fn() };
  const ctx = {
    scope: 'oc_1',
    workspaces: {
      cwdFor: () => tmp,
      listNamed: () => ({ bridge: tmp }),
      setCwd: spy.setCwd,
    },
    sessions: store,
    // renderContext (reached through applyResume) asks whether a run is live.
    activeRuns: { interrupt: spy.interrupt, has: () => false },
    agent: {},
    controls: { cfg: {} },
    channel: { send: async () => {} },
    msg: { chatId: 'oc_1', messageId: 'om_1' },
    fromCardAction: false,
    ...over,
  } as unknown as CommandContext;
  return { ctx, spy, store };
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

  it('marks the scope that currently holds each session, else null', async () => {
    await writeSession('held.jsonl', { id: 'held', cwd: tmp, ts: '2026-01-01T00:00:00Z' }, 1, Date.now() - 1_000);
    await writeSession('free.jsonl', { id: 'free', cwd: tmp, ts: '2026-01-01T00:00:00Z' }, 1, Date.now() - 2_000);
    const store = makeStore();
    store.bind('oc_9', 'held', tmp);

    const records = await scanSessionFiles(makeCtx({ sessions: store }).ctx);
    expect(records.find((r) => r.sessionId === 'held')?.scope).toBe('oc_9');
    expect(records.find((r) => r.sessionId === 'free')?.scope).toBeNull();
  });

  it('does not invent a row for a session whose JSONL is gone', async () => {
    const store = makeStore();
    store.bind('oc_1', 'ghost', tmp);

    const records = await scanSessionFiles(makeCtx({ sessions: store }).ctx);
    expect(records.map((r) => r.sessionId)).not.toContain('ghost');
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

  it('defaults to the CURRENT conversation directory, not the chat window cwd', async () => {
    const store = makeStore();
    // 先开 /repo/old 那段，再开 tmp 那段（= 当前会话）。
    store.bind('oc_1', 'there-ws', '/repo/old');
    store.startNew('oc_1');
    store.bind('oc_1', 'here-ws', tmp);
    await writeSession('there.jsonl', { id: 'there-ws', cwd: '/repo/old', ts: '2026-01-01T00:00:00Z' }, 1, Date.now() - 100_000, 'OLD');
    await writeSession('here.jsonl', { id: 'here-ws', cwd: tmp, ts: '2026-01-02T00:00:00Z' }, 2, Date.now() - 50_000, 'NEW');

    // 聊天窗口的 cwd 故意指到别处：默认视图必须跟着**会话**走（会话在哪跑就看哪）。
    const { ctx } = makeCtx({
      sessions: store,
      workspaces: { cwdFor: () => '/repo/elsewhere', listNamed: () => ({}), setCwd: () => {} },
    });
    await handleHistory('', ctx);
    const card = cardJson();

    expect(card).toContain('NEW 问题 1');
    expect(card).not.toContain('OLD 问题 0');
    // 行的身份就是会话 id（= 「继续对话」的载荷）。
    expect(card).toContain('🆔 here-ws');
    expect(card).not.toContain('there-ws');
  });

  it('lists every workspace with /history all, labelled per row', async () => {
    await handleHistory('all', makeCtx().ctx);
    const card = cardJson();
    expect(card).toContain('全部工作区 · 3 个会话');
    expect(card).toContain('📁 bridge');
    expect(card).toContain('📁 /repo/b');
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
    const { ctx, spy, store } = makeCtx();
    await handleHistory('resume s3', ctx);
    // s3 is unclaimed history: the scope binds to it with ITS OWN start time
    // (from the session file), not the moment of the click, and any in-flight
    // run in this scope is interrupted.
    expect(store.sessionFor('oc_1')).toEqual({ sessionId: 's3', cwd: tmp });
    const raw = store.getRaw('oc_1')!;
    expect(raw.createdAt).toBe(Date.parse('2026-01-02T00:00:00Z'));
    // 时间取会话文件的最后活动（≈2 分钟前），不是点击的此刻。
    expect(Date.now() - raw.updatedAt).toBeGreaterThan(60_000);
    expect(spy.setCwd).toHaveBeenCalledWith('oc_1', tmp);
    expect(spy.interrupt).toHaveBeenCalledWith('oc_1');
    // The listing is not re-sent — the resume replies instead.
    expect(sendManagedCard).not.toHaveBeenCalled();
  });

  it('继续无归属历史：自开一段对话，不顶着当前会话的名字', async () => {
    const store = makeStore();
    // The chat is mid-way through another conversation, with a name.
    store.bind('oc_1', 's1', tmp);
    store.setTitle('oc_1', '别的活的名字');

    const { ctx } = makeCtx({ sessions: store });
    await applyResume(ctx, {
      sessionId: 's3',
      cwd: tmp,
      timestamp: '2026-01-02T00:00:00Z',
      updatedAtMs: 1_700_000_000_000,
      summary: '',
    });

    // s3 is unclaimed history: continuing it binds the scope to s3 with the
    // session file's own times, never wearing the other conversation's name.
    expect(store.sessionFor('oc_1')).toEqual({ sessionId: 's3', cwd: tmp });
    const raw = store.getRaw('oc_1')!;
    expect(raw.createdAt).toBe(Date.parse('2026-01-02T00:00:00Z'));
    expect(raw.updatedAt).toBe(1_700_000_000_000);
    expect(store.titleFor('s1')).toBe('别的活的名字');
    expect(renderContext(ctx, {})).not.toContain('别的活的名字');
  });

  it('refuses a 继续对话 payload whose session is gone', async () => {
    const { ctx, store } = makeCtx();
    await handleHistory('resume deleted-session', ctx);
    expect(store.sessionFor('oc_1')).toBeUndefined();
    expect(reply.mock.calls[0]![1]).toContain('未找到会话');
  });

  it('marks the scope own session in the listing', async () => {
    const store = makeStore();
    store.bind('oc_1', 's3', tmp);
    const { ctx } = makeCtx({ sessions: store });
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
