import { mkdir, mkdtemp, rm, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import { paths } from '../../config/paths';
import type { CommandContext } from '../index';
import { applyResume, listResumableSessions } from './resume';
import { handleHistory } from './history';
import { loadSessionSummary, renderContext } from './context';
import { SessionStore } from '../../session/store';

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

async function openStore(): Promise<SessionStore> {
  const store = new SessionStore(join(tmp, 'sessions.json'));
  await store.load();
  return store;
}

interface CtxSpy {
  ctx: CommandContext;
  setCwd: Mock;
  interrupt: Mock;
}

function makeCtx(store: SessionStore, over: Record<string, unknown> = {}): CtxSpy {
  const setCwd = vi.fn();
  const interrupt = vi.fn();
  const ctx = {
    scope: 'oc_1',
    chatMode: 'p2p',
    workspaces: { cwdFor: () => tmp, listNamed: () => ({}), setCwd },
    sessions: store,
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

describe('applyResume binding a conversation', () => {
  it('refuses when another scope currently holds the session', async () => {
    const a = await dir('a');
    await writeSession('ws-x', a);
    const store = await openStore();
    store.bind('oc_1', 'ws-x', a); // oc_1 is using it

    const { ctx, setCwd, interrupt } = makeCtx(store, { scope: 'oc_2' });
    await applyResume(ctx, {
      sessionId: 'ws-x',
      cwd: a,
      timestamp: new Date(1).toISOString(),
    });

    expect(store.sessionFor('oc_2')).toBeUndefined();
    expect(setCwd).not.toHaveBeenCalled();
    expect(interrupt).not.toHaveBeenCalled();
    expect(reply.mock.calls[0]![1]).toContain('占用');
    await store.flush();
  });

  it('未认领的历史文件：绑定到它，时间取会话文件', async () => {
    const a = await dir('a');
    await writeSession('legacy', a);
    const store = await openStore(); // no scope claims 'legacy'
    const { ctx, setCwd, interrupt } = makeCtx(store, { scope: 'oc_1' });

    await applyResume(ctx, {
      sessionId: 'legacy',
      cwd: a,
      timestamp: new Date(1000).toISOString(),
      updatedAtMs: 4242,
    });

    expect(store.sessionFor('oc_1')).toEqual({ sessionId: 'legacy', cwd: a });
    const raw = store.getRaw('oc_1')!;
    // Times come from the session file (match payload), not `now`.
    expect(raw.createdAt).toBe(1000);
    expect(raw.updatedAt).toBe(4242);
    expect(setCwd).toHaveBeenCalledWith('oc_1', a);
    expect(interrupt).toHaveBeenCalledWith('oc_1');
    await store.flush();
  });

  it('继续无归属历史：绑定到它，不顶着当前会话的标题', async () => {
    const a = await dir('a');
    await writeSession('legacy', a);
    const store = await openStore();
    // The chat is in the middle of another conversation, with a name.
    store.bind('oc_1', 'sess-other', a);
    store.setTitle('oc_1', '更新 UI 效果以及扩展功能');
    const { ctx } = makeCtx(store, { scope: 'oc_1' });

    // /history 继续对话 on the unclaimed conversation's row.
    await applyResume(ctx, {
      sessionId: 'legacy',
      cwd: a,
      timestamp: new Date(1000).toISOString(),
      updatedAtMs: 4242,
    });

    expect(store.sessionFor('oc_1')?.sessionId).toBe('legacy');
    expect(store.titleFor('legacy')).toBeUndefined();
    // The other conversation keeps its own name.
    expect(store.titleFor('sess-other')).toBe('更新 UI 效果以及扩展功能');
    const text = renderContext(ctx, {});
    expect(text).toContain('`legacy`');
    expect(text).not.toContain('更新 UI 效果以及扩展功能');
    await store.flush();
  });
});

describe('applyResume refuses a ghost session (its file is gone)', () => {
  it('via /resume: refuses and does not adopt', async () => {
    const a = await dir('a');
    const store = await openStore();
    store.bind('oc_1', 'seg-x', a);
    store.bind('oc_1', 'seg-y', a); // current = seg-y
    store.startNew('oc_1'); // archived: another chat may resume it
    const { ctx, setCwd, interrupt } = makeCtx(store, { scope: 'oc_2' });
    reply.mockClear();

    await applyResume(ctx, {
      sessionId: 'seg-y',
      cwd: a,
      timestamp: new Date(1).toISOString(),
    });

    expect(reply.mock.calls[0]![1]).toContain('会话文件已不存在');
    expect(reply.mock.calls[0]![1]).toContain('无法恢复');
    expect(store.sessionFor('oc_2')).toBeUndefined();
    expect(setCwd).not.toHaveBeenCalled();
    expect(interrupt).not.toHaveBeenCalled();
    await store.flush();
  });

  it('via /history 继续对话: refuses and does not adopt', async () => {
    const a = await dir('a');
    const store = await openStore();
    store.bind('oc_1', 'seg-x', a);
    const { ctx } = makeCtx(store, { scope: 'oc_2' });
    reply.mockClear();

    await handleHistory('resume seg-x', ctx);

    expect(reply.mock.calls[0]![1]).toContain('未找到会话');
    expect(store.sessionFor('oc_2')).toBeUndefined();
    await store.flush();
  });
});

describe('listResumableSessions', () => {
  it('lists one row per OMP session (one session = one conversation)', async () => {
    const a = await dir('a');
    await writeSession('s1', a, 1, Date.now() - 1000);
    await writeSession('s2', a, 1, Date.now() - 500);
    const store = await openStore();
    store.bind('oc_1', 's1', a);
    store.bind('oc_1', 's2', a);
    store.startNew('oc_1'); // archived: no chat currently holds it

    const { ctx } = makeCtx(store, { scope: 'oc_9' });
    const options = await listResumableSessions(ctx);
    // 两段会话 = 两个可恢复的对话，各自带着自己的 id。
    expect(options.map((o) => o.sessionId).sort()).toEqual(['s1', 's2']);
    expect(options.every((o) => o.timestamp === '2026-01-01T00:00:00Z')).toBe(true);
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
