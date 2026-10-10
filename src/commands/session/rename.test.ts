import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type * as Shared from '../shared';
import { paths } from '../../config/paths';
import { WorkSessionStore } from '../../session/work-store';
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

/** Minimal ctx for driving the real /new handler and capturing its card. */
function makeNewCtx(): { ctx: CommandContext; sent: unknown[] } {
  const sent: unknown[] = [];
  const ctx = {
    scope: 'oc_1',
    chatMode: 'p2p',
    workSessions: store,
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

  it('auto lands on the work session that was active when generation started (user ran /work)', async () => {
    store.bindSegment('oc_1', 'sess-a', '/repo', { startedAtMs: 1, lastActiveAtMs: 1 });
    await writeSessionFile('sess-a', '帮我改搜索逻辑');
    const target = store.activeWorkSession('oc_1')!.id;

    // 生成期间用户 /work 归档了当前工作会话：不再有 active。
    const agent = agentYieldingWith('新标题', () => store.startWorkSession('oc_1'));
    const ctx = makeCtx({ agent: agent as never });

    await handleRename('auto', ctx);

    expect(store.activeWorkSession('oc_1')).toBeUndefined();
    // 名字仍落在发起时那个工作会话上，而不是「报成功但没写」。
    expect(store.workSessionById(target)?.title).toBe('新标题');
    expect(reply).toHaveBeenLastCalledWith(ctx, expect.stringContaining('已自动生成'));
  });

  it('auto keeps its target when /resume switches to another work session', async () => {
    // 第一摊活（生成发起时它是「切过去」的目的地）。
    store.bindSegment('oc_1', 'sess-target', '/repo', { startedAtMs: 1, lastActiveAtMs: 1 });
    store.setTitle('oc_1', '第一摊活');
    await writeSessionFile('sess-target', '第一摊活的消息');
    const firstId = store.activeWorkSession('oc_1')!.id;
    // 第二摊活，随后成为 active（生成发起时的目标）。
    store.startWorkSession('oc_1', '当前活');
    store.bindSegment('oc_1', 'sess-other', '/repo', { startedAtMs: 2, lastActiveAtMs: 2 });
    await writeSessionFile('sess-other', '第二摊活的消息');
    const targetId = store.activeWorkSession('oc_1')!.id;
    expect(targetId).not.toBe(firstId);
    expect(store.workSessionById(targetId)?.title).toBe('当前活');

    // 生成期间用户 /resume 切回第一摊活。
    const agent = agentYieldingWith('新标题', () => {
      store.adoptWorkSession('oc_1', firstId);
    });
    const ctx = makeCtx({ agent: agent as never });

    await handleRename('auto', ctx);

    expect(store.activeWorkSession('oc_1')?.id).toBe(firstId);
    // 名字落在发起时的目标工作会话上，绝不覆盖切过去的那个活。
    expect(store.workSessionById(targetId)?.title).toBe('新标题');
    expect(store.workSessionById(firstId)?.title).toBe('第一摊活');
    expect(reply).toHaveBeenLastCalledWith(ctx, expect.stringContaining('已自动生成'));
  });

  it('auto reports the name was NOT saved when the target work session is gone', async () => {
    store.bindSegment('oc_1', 'sess-a', '/repo', { startedAtMs: 1, lastActiveAtMs: 1 });
    await writeSessionFile('sess-a', '帮我改搜索逻辑');
    const ctx = makeCtx({ agent: agentYielding('新标题') as never });
    // 生成期间目标工作会话消失（按 id 写入失败）。
    vi.spyOn(store, 'setTitleById').mockReturnValue(false);

    await handleRename('auto', ctx);

    expect(reply).toHaveBeenLastCalledWith(
      ctx,
      expect.stringContaining('目标工作会话已不存在'),
    );
    expect(store.activeWorkSession('oc_1')?.title).toBeUndefined();
  });

  it('truncates and escapes the fallback message in the no-arg query', async () => {
    store.bindSegment('oc_1', 'sess-a', '/repo', { startedAtMs: 1, lastActiveAtMs: 1 });
    // 超过 40 字、且带反引号 / markdown 元字符的原始用户消息，末尾放个哨兵。
    const raw = '先看一下 `rm -rf` 和 *重点* 这些标记，再补充一长串填充内容凑到四十个字以上 ZZZ';
    await writeSessionFile('sess-a', raw);
    const ctx = makeCtx();

    await handleRename('', ctx);

    const shown = reply.mock.calls.at(-1)?.[1] as string;
    expect(shown).toContain('…'); // 已截断
    expect(shown).not.toContain('ZZZ'); // 哨兵在 40 字外，被截掉
    expect(shown).not.toContain('`rm -rf`'); // 用户反引号被中和，代码段没被提前闭合
    expect(shown).toContain('\\*重点\\*'); // markdown 元字符已转义
  });
});

describe('/rename 与 /new 展示口径一致', () => {
  it('both prefer the work session title', async () => {
    store.bindSegment('oc_1', 'sess-a', '/repo', { startedAtMs: 1, lastActiveAtMs: 1 });
    store.setTitle('oc_1', 'KMP 导出');

    await handleRename('', makeCtx());
    expect(reply).toHaveBeenLastCalledWith(expect.anything(), expect.stringContaining('KMP 导出'));

    const { ctx, sent } = makeNewCtx();
    await newHandlers['/new']!('', ctx);
    expect(JSON.stringify(sent[0])).toContain('KMP 导出');
  });

  it('both fall back to the LATEST segment last user message, not an older one', async () => {
    store.bindSegment('oc_1', 'sess-old', '/repo', { startedAtMs: 1, lastActiveAtMs: 1 });
    store.bindSegment('oc_1', 'sess-new', '/repo', { startedAtMs: 2, lastActiveAtMs: 2 });
    await writeSessionFile('sess-old', '旧段的消息');
    await writeSessionFile('sess-new', '最新段的消息');

    await handleRename('', makeCtx());
    const shown = reply.mock.calls.at(-1)?.[1] as string;
    expect(shown).toContain('最新段的消息');
    expect(shown).not.toContain('旧段的消息');

    const { ctx, sent } = makeNewCtx();
    await newHandlers['/new']!('', ctx);
    const card = JSON.stringify(sent[0]);
    expect(card).toContain('最新段的消息');
    expect(card).not.toContain('旧段的消息');
  });

  it('both show no name when there is no title and no history', async () => {
    store.bindSegment('oc_1', 'sess-a', '/repo', { startedAtMs: 1, lastActiveAtMs: 1 });

    await handleRename('', makeCtx());
    expect(reply).toHaveBeenLastCalledWith(expect.anything(), expect.stringContaining('未命名'));

    const { ctx, sent } = makeNewCtx();
    await newHandlers['/new']!('', ctx);
    const card = JSON.stringify(sent[0]);
    expect(card).not.toContain('未命名');
    expect(card).not.toContain('🧵');
  });
});
