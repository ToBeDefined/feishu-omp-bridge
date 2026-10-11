import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type * as Shared from '../shared';
import { paths } from '../../config/paths';
import { SessionStore } from '../../session/store';
import type { CommandContext } from '../index';
import { handleRename, renameHandlers } from './rename';
import { newHandlers } from './new';

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
let store: SessionStore;

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

/** An agent whose generation runs `during()` first — a hook to simulate the user
 * issuing /work or /resume while the (async) title generation is in flight. */
function agentYieldingWith(text: string, during: () => void) {
  async function* events() {
    during();
    yield { type: 'text', delta: text };
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
    sessions: store,
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

/** Minimal ctx for driving the real /new handler and capturing its card. */
function makeNewCtx(): { ctx: CommandContext; sent: unknown[] } {
  const sent: unknown[] = [];
  const ctx = {
    scope: 'oc_1',
    chatMode: 'p2p',
    sessions: store,
    workspaces: { cwdFor: () => '/repo', clearUndo: vi.fn() },
    agent: {} as never,
    activeRuns: { interrupt: vi.fn().mockReturnValue(false) },
    channel: {
      send: async (_chatId: string, payload: { card?: object; markdown?: string }) => {
        sent.push(payload.card ?? payload.markdown);
      },
    },
    msg: { chatId: 'oc_1', messageId: 'om_1', content: '', senderId: 'ou_1' },
    // cfg = {} → getOmpSessionDir falls back to paths.ompSessionsDir, which this
    // suite already points at `sessionsDir`; both /rename and /new read the same
    // directory, so the consistency assertion is meaningful.
    controls: { cfg: {} },
  } as unknown as CommandContext;
  return { ctx, sent };
}

beforeEach(async () => {
  reply.mockClear();
  tmp = await mkdtemp(join(tmpdir(), 'rename-test-'));
  sessionsDir = join(tmp, 'omp-sessions');
  await mkdir(sessionsDir, { recursive: true });
  paths.ompSessionsDir = sessionsDir;
  store = new SessionStore(join(tmp, 'sessions.json'));
  await store.load();
});
afterEach(async () => {
  await store.flush();
  paths.ompSessionsDir = origSessionsDir;
  await rm(tmp, { recursive: true, force: true });
});

describe('/rename command', () => {
  it('names the current session; after /new the name stays on that conversation', async () => {
    store.bind('oc_1', 'sess-a', '/repo');
    const ctx = makeCtx();

    await handleRename('bridge UI 调整', ctx);
    expect(store.titleFor('sess-a')).toBe('bridge UI 调整');

    // 一个 OMP 会话 = 一个对话：/new 起一段新对话，名字属于旧对话，新对话无名。
    store.startNew('oc_1');
    store.bind('oc_1', 'sess-b', '/repo');
    await handleRename('', ctx);

    // 新对话没有标题 → 如实说「没有标题」（不拿最后一条消息冒充）。
    expect(reply).toHaveBeenLastCalledWith(ctx, expect.stringContaining('没有标题'));
    expect(store.titleFor('sess-a')).toBe('bridge UI 调整');
    expect(store.titleFor('sess-b')).toBeUndefined();
  });

  it('clears only the current conversation after /new (旧对话名字不受影响)', async () => {
    store.bind('oc_1', 'sess-a', '/repo');
    const ctx = makeCtx();

    await handleRename('旧标题', ctx);
    store.startNew('oc_1');
    store.bind('oc_1', 'sess-b', '/repo');
    await handleRename('clear', ctx);

    // 新对话本就没有标题：clear 无事可清，也绝不该动到旧对话的名字。
    expect(reply).toHaveBeenLastCalledWith(ctx, expect.stringContaining('本就没有标题'));
    expect(store.titleFor('sess-a')).toBe('旧标题');
    expect(store.titleFor('sess-b')).toBeUndefined();
  });

  it('reports the same hint and writes nothing when there is no session yet', async () => {
    const agent = agentYielding();
    const ctx = makeCtx({ agent: agent as never });

    await handleRename('X', ctx);
    await handleRename('clear', ctx);
    await handleRename('', ctx);
    await handleRename('auto', ctx);

    expect(reply).toHaveBeenCalledTimes(4);
    for (const call of reply.mock.calls) {
      expect(call[1]).toBe('❌ 当前还没有会话，先发一条消息开始一段对话。');
    }
    // Nothing written to the store, and auto didn't even talk to the model.
    expect(store.sessionFor('oc_1')).toBeUndefined();
    expect(store.titlesBySessionId()).toEqual({});
    expect(agent.run).not.toHaveBeenCalled();
    await store.flush();
    await expect(readFile(join(tmp, 'sessions.json'), 'utf8')).rejects.toThrow();
  });

  it('shows the current session title with no args', async () => {
    store.bind('oc_1', 'sess-a', '/repo');
    const ctx = makeCtx();

    await handleRename('现有标题', ctx);
    await handleRename('', ctx);

    expect(reply).toHaveBeenLastCalledWith(ctx, expect.stringContaining('现有标题'));
  });

  it('rejects an over-long title', async () => {
    store.bind('oc_1', 'sess-a', '/repo');
    const ctx = makeCtx();

    await handleRename('x'.repeat(61), ctx);

    expect(reply).toHaveBeenCalledWith(ctx, expect.stringContaining('过长'));
    expect(store.titleFor('sess-a')).toBeUndefined();
  });

  it('auto samples only the current session, in an isolated session dir', async () => {
    store.bind('oc_1', 'sess-old', '/repo');
    store.bind('oc_1', 'sess-new', '/repo');
    await writeSessionFile('sess-old', '旧段的消息');
    await writeSessionFile('sess-new', '最新段的消息');

    const agent = agentYielding('新标题');
    const ctx = makeCtx({ agent: agent as never });
    await handleRename('auto', ctx);

    expect(reply).toHaveBeenLastCalledWith(ctx, expect.stringContaining('已自动生成'));
    expect(store.titleFor('sess-new')).toBe('新标题');

    const runArgs = agent.run.mock.calls[0]?.[0] as { prompt: string; sessionDir?: string; sessionId?: string };
    expect(runArgs?.prompt).toContain('最新段的消息');
    expect(runArgs?.prompt).not.toContain('旧段的消息');
    // Isolation: throwaway dir, never resumes the current session.
    expect(runArgs?.sessionDir).toBeTruthy();
    expect(runArgs?.sessionDir).not.toBe(paths.ompSessionsDir);
    expect(runArgs?.sessionId).toBeUndefined();
  });

  it('truncates an over-long generated title to 30 chars', async () => {
    store.bind('oc_1', 'sess-a', '/repo');
    await writeSessionFile('sess-a', '帮我改搜索逻辑');
    const longTitle = '这是一条特别长的自动生成标题测试内容用来验证截断逻辑是否正确生效超三十字';
    const ctx = makeCtx({ agent: agentYielding(longTitle) as never });

    await handleRename('auto', ctx);

    const title = store.titleFor('sess-a');
    expect(Array.from(title ?? '')).toHaveLength(30);
  });

  it('leaves the main session file untouched when generating', async () => {
    store.bind('oc_1', 'sess-a', '/repo');
    const file = await writeSessionFile('sess-a', '帮我改搜索逻辑');
    const before = await readFile(file, 'utf8');
    const ctx = makeCtx({ agent: agentYielding('好标题') as never });

    await handleRename('auto', ctx);

    const after = await readFile(file, 'utf8');
    expect(after).toBe(before);
  });

  it('fails gracefully when the model produces no text', async () => {
    store.bind('oc_1', 'sess-a', '/repo');
    await writeSessionFile('sess-a', '帮我改搜索逻辑');
    const ctx = makeCtx({ agent: agentYielding('   ') as never });

    await handleRename('auto', ctx);

    expect(reply).toHaveBeenLastCalledWith(ctx, expect.stringContaining('无法生成标题'));
    expect(store.titleFor('sess-a')).toBeUndefined();
  });

  it('is registered as the /rename command', () => {
    expect(renameHandlers['/rename']).toBe(handleRename);
  });

  it('auto lands on the session that was active when generation started (user ran /new)', async () => {
    store.bind('oc_1', 'sess-a', '/repo');
    await writeSessionFile('sess-a', '帮我改搜索逻辑');
    const target = store.sessionFor('oc_1')!.sessionId;

    // 生成期间用户 /new 起了一段新对话：当前会话已不挂在 scope 上。
    const agent = agentYieldingWith('新标题', () => store.startNew('oc_1'));
    const ctx = makeCtx({ agent: agent as never });

    await handleRename('auto', ctx);

    expect(store.sessionFor('oc_1')).toBeUndefined();
    // 名字仍落在发起时那条会话上（名字表按会话 id 存，历史会话照样能起名）。
    expect(store.titleFor(target)).toBe('新标题');
    expect(reply).toHaveBeenLastCalledWith(ctx, expect.stringContaining('已自动生成'));
  });

  it('auto keeps its target when /resume switches to another session', async () => {
    // 第一段活（生成发起时它是「切过去」的目的地）。
    store.bind('oc_1', 'sess-target', '/repo');
    store.setTitle('oc_1', '第一摊活');
    await writeSessionFile('sess-target', '第一摊活的消息');
    const firstId = store.sessionFor('oc_1')!.sessionId;
    // 第二段活，随后成为当前会话（生成发起时的目标）。
    store.startNew('oc_1');
    store.bind('oc_1', 'sess-other', '/repo');
    store.setTitle('oc_1', '当前活');
    await writeSessionFile('sess-other', '第二摊活的消息');
    const targetId = store.sessionFor('oc_1')!.sessionId;
    expect(targetId).not.toBe(firstId);
    expect(store.titleFor(targetId)).toBe('当前活');

    // 生成期间用户 /resume 切回第一段活。
    const agent = agentYieldingWith('新标题', () => {
      store.bind('oc_1', firstId, '/repo');
    });
    const ctx = makeCtx({ agent: agent as never });

    await handleRename('auto', ctx);

    expect(store.sessionFor('oc_1')?.sessionId).toBe(firstId);
    // 名字落在发起时的目标会话上，绝不覆盖切过去的那个活。
    expect(store.titleFor(targetId)).toBe('新标题');
    expect(store.titleFor(firstId)).toBe('第一摊活');
    expect(reply).toHaveBeenLastCalledWith(ctx, expect.stringContaining('已自动生成'));
  });

});

describe('/rename 与 /new：/new 起新对话，不背旧名字', () => {
  it('/rename 报当前对话的名字，/new 的卡片不带它（名字留在旧对话上）', async () => {
    store.bind('oc_1', 'sess-a', '/repo');
    store.setTitle('oc_1', 'KMP 导出');

    await handleRename('', makeCtx());
    expect(reply).toHaveBeenLastCalledWith(expect.anything(), expect.stringContaining('KMP 导出'));

    const { ctx, sent } = makeNewCtx();
    await newHandlers['/new']!('', ctx);
    // 一个 OMP 会话 = 一个对话：/new 只是重置上下文、另起一段新对话，卡片报到即可，
    // 不该再顶着旧对话的名字（旧名字仍留在旧对话上）。
    expect(JSON.stringify(sent[0])).not.toContain('KMP 导出');
    expect(store.titleFor('sess-a')).toBe('KMP 导出');
  });

  it('both show no name when there is no title and no history', async () => {
    store.bind('oc_1', 'sess-a', '/repo');

    await handleRename('', makeCtx());
    expect(reply).toHaveBeenLastCalledWith(expect.anything(), expect.stringContaining('没有标题'));

    const { ctx, sent } = makeNewCtx();
    await newHandlers['/new']!('', ctx);
    const card = JSON.stringify(sent[0]);
    expect(card).not.toContain('未命名');
    expect(card).not.toContain('🧵');
  });
});
