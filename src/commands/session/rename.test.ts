import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { CommandContext } from '../index';
import { handleRename } from './rename';

const { reply, loadSessionSummary } = vi.hoisted(() => ({
  reply: vi.fn(async () => {}),
  loadSessionSummary: vi.fn(async () => ({ lastMessage: '', lastReply: '' })),
}));

vi.mock('../shared', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../shared')>();
  return { ...actual, reply };
});
vi.mock('./context', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./context')>();
  return { ...actual, loadSessionSummary };
});

/** Build an agent mock whose run yields the given text events then `done`. */
function agentYielding(...texts: string[]) {
  async function* events() {
    for (const t of texts) yield { type: 'text', delta: t };
    yield { type: 'done' };
  }
  return {
    run: vi.fn(() => ({ events: events(), stop: vi.fn(async () => {}) })),
  };
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

beforeEach(() => {
  reply.mockClear();
  loadSessionSummary.mockResolvedValue({ lastMessage: '帮我改一下搜索逻辑', lastReply: '已改好跨会话搜索' });
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

  it('generates a title with LLM and caps it at 20 chars', async () => {
    const longTitle = '这是一条特别长的自动生成标题测试内容用来验证截断逻辑';
    const agent = agentYielding(longTitle);
    const ctx = makeCtx({ agent: agent as never });
    await handleRename('auto', ctx);

    expect(reply).toHaveBeenLastCalledWith(ctx, expect.stringContaining('已自动生成标题'));
    const title = (ctx.sessions.getRaw('oc_1') as { title?: string }).title;
    expect(Array.from(title ?? '')).toHaveLength(20);
    // Generated in the current session (resumed), not a fresh one.
    expect(agent.run).toHaveBeenCalledWith(expect.objectContaining({ sessionId: 's1' }));
  });

  it('fails gracefully when the model produces no text', async () => {
    const ctx = makeCtx({ agent: agentYielding('   ') as never });
    await handleRename('auto', ctx);
    expect(reply).toHaveBeenLastCalledWith(ctx, expect.stringContaining('无法生成标题'));
    expect((ctx.sessions.getRaw('oc_1') as { title?: string }).title).toBeUndefined();
  });
});
