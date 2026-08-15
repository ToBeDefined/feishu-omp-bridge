import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { paths } from '../../config/paths';
import type { CommandContext } from '../index';
import { handleRename } from './rename';

const { reply } = vi.hoisted(() => ({ reply: vi.fn(async () => {}) }));

vi.mock('../shared', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../shared')>();
  return { ...actual, reply };
});

const origSessionsDir = paths.ompSessionsDir;
let tmp: string;

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
  const title: { value?: string } = {};
  return {
    sessions: {
      getRaw: () => ({ sessionId: 's1', title: title.value }),
      setTitle: (_c: string, t: string) => {
        title.value = t;
      },
      clearTitle: () => {
        const had = title.value !== undefined;
        title.value = undefined;
        return had;
      },
    },
    agent: agentYielding() as never,
    workspaces: { cwdFor: () => '/repo' },
    controls: { cfg: {} },
    channel: { send: async () => {} },
    msg: { chatId: 'oc_1', messageId: 'om_1' },
    ...overrides,
  } as unknown as CommandContext;
}

/** Write a session file for s1 with a real user message (and optional extra
 * marked lines). `loadRecentUserMessages` reads this. */
async function writeSessionFile(extraLines: string[] = []): Promise<string> {
  const file = join(tmp, 'sess.jsonl');
  const lines = [
    JSON.stringify({ type: 'session', id: 's1', cwd: '/repo', timestamp: 't' }),
    JSON.stringify({ type: 'message', timestamp: 't1', message: { role: 'user', content: [{ type: 'text', text: '帮我改搜索逻辑' }] } }),
    JSON.stringify({ type: 'message', timestamp: 't2', message: { role: 'assistant', content: [{ type: 'text', text: '已改好' }] } }),
    ...extraLines,
  ];
  await writeFile(file, lines.join('\n') + '\n', 'utf8');
  return file;
}

beforeEach(async () => {
  reply.mockClear();
  tmp = await mkdtemp(join(tmpdir(), 'rename-test-'));
  paths.ompSessionsDir = tmp;
});
afterEach(async () => {
  paths.ompSessionsDir = origSessionsDir;
  await rm(tmp, { recursive: true, force: true });
});

describe('/rename command', () => {
  it('sets a title', async () => {
    const ctx = makeCtx();
    await handleRename('修 search bug', ctx);
    expect(reply).toHaveBeenCalledWith(ctx, expect.stringContaining('修 search bug'));
    expect((ctx.sessions.getRaw('oc_1') as { title?: string }).title).toBe('修 search bug');
  });

  it('clears a title with `clear`', async () => {
    const ctx = makeCtx();
    await handleRename('旧标题', ctx);
    await handleRename('clear', ctx);
    expect(reply).toHaveBeenLastCalledWith(ctx, expect.stringContaining('已清除'));
    expect((ctx.sessions.getRaw('oc_1') as { title?: string }).title).toBeUndefined();
  });

  it('shows current title with no args', async () => {
    const ctx = makeCtx();
    await handleRename('现有标题', ctx);
    await handleRename('', ctx);
    expect(reply).toHaveBeenLastCalledWith(ctx, expect.stringContaining('现有标题'));
  });

  it('rejects an over-long title', async () => {
    const ctx = makeCtx();
    await handleRename('x'.repeat(61), ctx);
    expect(reply).toHaveBeenCalledWith(ctx, expect.stringContaining('过长'));
    expect((ctx.sessions.getRaw('oc_1') as { title?: string }).title).toBeUndefined();
  });

  it('generates a title from user messages only, in the current session', async () => {
    await writeSessionFile();
    const longTitle = '这是一条特别长的自动生成标题测试内容用来验证截断逻辑';
    const agent = agentYielding(longTitle);
    const ctx = makeCtx({ agent: agent as never });
    await handleRename('auto', ctx);

    expect(reply).toHaveBeenLastCalledWith(ctx, expect.stringContaining('已自动生成标题'));
    const title = (ctx.sessions.getRaw('oc_1') as { title?: string }).title;
    expect(Array.from(title ?? '')).toHaveLength(20);
    // Prompt feeds the user's messages only (no assistant reply), and the
    // run resumes the current session.
    const runArgs = agent.run.mock.calls[0]?.[0] as { prompt: string; sessionId?: string };
    expect(runArgs?.sessionId).toBe('s1');
    expect(runArgs?.prompt).toContain('帮我改搜索逻辑');
    expect(runArgs?.prompt).not.toContain('已改好');
  });

  it('strips the marked generation prompt from the session history', async () => {
    const file = await writeSessionFile([
      JSON.stringify({ type: 'message', timestamp: 't3', message: { role: 'user', content: [{ type: 'text', text: '根据最近的对话 <rename-auto-title> 生成标题' }] } }),
    ]);

    const ctx = makeCtx({ agent: agentYielding('好标题') as never });
    await handleRename('auto', ctx);

    const after = await readFile(file, 'utf8');
    expect(after).not.toContain('<rename-auto-title>');
    expect(after).toContain('帮我改搜索逻辑');
  });

  it('fails gracefully when the model produces no text', async () => {
    await writeSessionFile();
    const ctx = makeCtx({ agent: agentYielding('   ') as never });
    await handleRename('auto', ctx);
    expect(reply).toHaveBeenLastCalledWith(ctx, expect.stringContaining('无法生成标题'));
    expect((ctx.sessions.getRaw('oc_1') as { title?: string }).title).toBeUndefined();
  });
});
