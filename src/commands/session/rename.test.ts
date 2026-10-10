import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type * as Shared from '../shared';
import { paths } from '../../config/paths';
import { WorkSessionStore } from '../../session/work-store';
import type { CommandContext } from '../index';
import { handleRename, renameHandlers } from './rename';

const { reply } = vi.hoisted(() => ({
  reply: vi.fn(async (_ctx: unknown, _text: string) => {}),
}));

vi.mock('../shared', async (importOriginal) => {
  const actual = await importOriginal<typeof Shared>();
  return { ...actual, reply };
});

const origSessionsDir = paths.ompSessionsDir;
let tmp: string;
let sessionsDir: string;
let store: WorkSessionStore;

function agentYielding(...texts: string[]) {
  async function* events() {
    for (const t of texts) yield { type: 'text', delta: t };
    yield { type: 'done' };
  }
  const run = vi.fn((_opts: { sessionId?: string; sessionDir?: string; prompt: string }) => ({
    events: events(),
    stop: vi.fn(async () => {}),
  }));
  return { run };
}

function makeCtx(overrides: Partial<CommandContext> = {}): CommandContext {
  return {
    scope: 'oc_1',
    workSessions: store,
    agent: agentYielding() as never,
    workspaces: { cwdFor: () => '/repo' },
    controls: { cfg: {} },
    channel: { send: async () => {} },
    msg: { chatId: 'oc_1', messageId: 'om_1' },
    ...overrides,
  } as unknown as CommandContext;
}

/** Write a real OMP session file for `sessionId` with one user message. */
async function writeSessionFile(sessionId: string, userText: string): Promise<string> {
  const file = join(sessionsDir, `${sessionId}.jsonl`);
  const lines = [
    JSON.stringify({ type: 'session', id: sessionId, cwd: '/repo', timestamp: 't' }),
    JSON.stringify({
      type: 'message',
      timestamp: 't1',
      message: { role: 'user', content: [{ type: 'text', text: userText }] },
    }),
    JSON.stringify({
      type: 'message',
      timestamp: 't2',
      message: { role: 'assistant', content: [{ type: 'text', text: '已改好' }] },
    }),
  ];
  await writeFile(file, lines.join('\n') + '\n', 'utf8');
  return file;
}

beforeEach(async () => {
  reply.mockClear();
  tmp = await mkdtemp(join(tmpdir(), 'rename-test-'));
  sessionsDir = join(tmp, 'omp-sessions');
  await mkdir(sessionsDir, { recursive: true });
  paths.ompSessionsDir = sessionsDir;
  store = new WorkSessionStore(join(tmp, 'sessions.json'));
  await store.load();
});
afterEach(async () => {
  await store.flush();
  paths.ompSessionsDir = origSessionsDir;
  await rm(tmp, { recursive: true, force: true });
});

describe('/rename command', () => {
  it('names the WORK session and keeps the name after /new', async () => {
    store.bindSegment('oc_1', 'sess-a', '/repo', { startedAtMs: 1, lastActiveAtMs: 1 });
    const ctx = makeCtx();

    await handleRename('bridge UI 调整', ctx);
    expect(store.activeWorkSession('oc_1')?.title).toBe('bridge UI 调整');

    // /new clears the current-segment pointer; the name lives on the work
    // session, so a no-arg query still finds it.
    store.dropCurrentSegment('oc_1');
    await handleRename('', ctx);

    expect(reply).toHaveBeenLastCalledWith(ctx, expect.stringContaining('bridge UI 调整'));
    expect(store.titleFor('sess-a')).toBe('bridge UI 调整');
  });

  it('clears the work session title after /new (same target as set)', async () => {
    store.bindSegment('oc_1', 'sess-a', '/repo', { startedAtMs: 1, lastActiveAtMs: 1 });
    const ctx = makeCtx();

    await handleRename('旧标题', ctx);
    store.dropCurrentSegment('oc_1');
    await handleRename('clear', ctx);

    expect(reply).toHaveBeenLastCalledWith(ctx, expect.stringContaining('已清除'));
    expect(store.titleFor('sess-a')).toBeUndefined();
  });

  it('reports the same hint and writes nothing when there is no work session', async () => {
    const agent = agentYielding();
    const ctx = makeCtx({ agent: agent as never });

    await handleRename('X', ctx);
    await handleRename('clear', ctx);
    await handleRename('', ctx);
    await handleRename('auto', ctx);

    expect(reply).toHaveBeenCalledTimes(4);
    for (const call of reply.mock.calls) {
      expect(call[1]).toBe('❌ 当前还没有工作会话，先发一条消息或用 /work 开始一件新工作。');
    }
    // Nothing written to the store, and auto didn't even talk to the model.
    expect(store.allWorkSessions()).toHaveLength(0);
    expect(agent.run).not.toHaveBeenCalled();
    await store.flush();
    await expect(readFile(join(tmp, 'sessions.json'), 'utf8')).rejects.toThrow();
  });

  it('shows the current work session title with no args', async () => {
    store.bindSegment('oc_1', 'sess-a', '/repo', { startedAtMs: 1, lastActiveAtMs: 1 });
    const ctx = makeCtx();

    await handleRename('现有标题', ctx);
    await handleRename('', ctx);

    expect(reply).toHaveBeenLastCalledWith(ctx, expect.stringContaining('现有标题'));
  });

  it('falls back to the latest segment last user message when unnamed', async () => {
    store.bindSegment('oc_1', 'sess-a', '/repo', { startedAtMs: 1, lastActiveAtMs: 1 });
    await writeSessionFile('sess-a', '看一下 KMP 的导出');
    const ctx = makeCtx();

    await handleRename('', ctx);

    expect(reply).toHaveBeenLastCalledWith(ctx, expect.stringContaining('看一下 KMP 的导出'));
  });

  it('reports unnamed when there is no title and no history', async () => {
    store.bindSegment('oc_1', 'sess-a', '/repo', { startedAtMs: 1, lastActiveAtMs: 1 });
    const ctx = makeCtx();

    await handleRename('', ctx);

    expect(reply).toHaveBeenLastCalledWith(ctx, expect.stringContaining('未命名'));
  });

  it('rejects an over-long title', async () => {
    store.bindSegment('oc_1', 'sess-a', '/repo', { startedAtMs: 1, lastActiveAtMs: 1 });
    const ctx = makeCtx();

    await handleRename('x'.repeat(61), ctx);

    expect(reply).toHaveBeenCalledWith(ctx, expect.stringContaining('过长'));
    expect(store.activeWorkSession('oc_1')?.title).toBeUndefined();
  });

  it('auto samples only the latest segment, in an isolated session dir', async () => {
    store.bindSegment('oc_1', 'sess-old', '/repo', { startedAtMs: 1, lastActiveAtMs: 1 });
    store.bindSegment('oc_1', 'sess-new', '/repo', { startedAtMs: 2, lastActiveAtMs: 2 });
    await writeSessionFile('sess-old', '旧段的消息');
    await writeSessionFile('sess-new', '最新段的消息');

    const agent = agentYielding('新标题');
    const ctx = makeCtx({ agent: agent as never });
    await handleRename('auto', ctx);

    expect(reply).toHaveBeenLastCalledWith(ctx, expect.stringContaining('已自动生成'));
    expect(store.activeWorkSession('oc_1')?.title).toBe('新标题');

    const runArgs = agent.run.mock.calls[0]?.[0] as { prompt: string; sessionDir?: string; sessionId?: string };
    expect(runArgs?.prompt).toContain('最新段的消息');
    expect(runArgs?.prompt).not.toContain('旧段的消息');
    // Isolation: throwaway dir, never resumes the current session.
    expect(runArgs?.sessionDir).toBeTruthy();
    expect(runArgs?.sessionDir).not.toBe(paths.ompSessionsDir);
    expect(runArgs?.sessionId).toBeUndefined();
  });

  it('truncates an over-long generated title to 30 chars', async () => {
    store.bindSegment('oc_1', 'sess-a', '/repo', { startedAtMs: 1, lastActiveAtMs: 1 });
    await writeSessionFile('sess-a', '帮我改搜索逻辑');
    const longTitle = '这是一条特别长的自动生成标题测试内容用来验证截断逻辑是否正确生效超三十字';
    const ctx = makeCtx({ agent: agentYielding(longTitle) as never });

    await handleRename('auto', ctx);

    const title = store.activeWorkSession('oc_1')?.title;
    expect(Array.from(title ?? '')).toHaveLength(30);
  });

  it('leaves the main session file untouched when generating', async () => {
    store.bindSegment('oc_1', 'sess-a', '/repo', { startedAtMs: 1, lastActiveAtMs: 1 });
    const file = await writeSessionFile('sess-a', '帮我改搜索逻辑');
    const before = await readFile(file, 'utf8');
    const ctx = makeCtx({ agent: agentYielding('好标题') as never });

    await handleRename('auto', ctx);

    const after = await readFile(file, 'utf8');
    expect(after).toBe(before);
  });

  it('fails gracefully when the model produces no text', async () => {
    store.bindSegment('oc_1', 'sess-a', '/repo', { startedAtMs: 1, lastActiveAtMs: 1 });
    await writeSessionFile('sess-a', '帮我改搜索逻辑');
    const ctx = makeCtx({ agent: agentYielding('   ') as never });

    await handleRename('auto', ctx);

    expect(reply).toHaveBeenLastCalledWith(ctx, expect.stringContaining('无法生成标题'));
    expect(store.activeWorkSession('oc_1')?.title).toBeUndefined();
  });

  it('is registered as the /rename command', () => {
    expect(renameHandlers['/rename']).toBe(handleRename);
  });
});
