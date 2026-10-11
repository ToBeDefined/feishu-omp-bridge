import { describe, expect, it } from 'vitest';
import type { CommandContext } from './index';
import { extractUserInput, renderContext } from './session';

const ULID = '019f0000-0000-7000-0000-000000000000';

/**
 * 一个 scope 的 store 条目 stub（一个 OMP 会话 = 一个对话：只有会话 id + cwd +
 * 时间，没有「工作会话 / 段」这一层）。
 */
interface EntryStub {
  sessionId?: string;
  cwd?: string;
  updatedAt?: number;
  createdAt?: number;
}

function sessionStub(over: { id?: string; title?: string; cwd?: string; createdAtMs?: number; updatedAtMs?: number } = {}) {
  const id = over.id ?? ULID;
  const cwd = over.cwd ?? '/home/proj';
  const at = over.createdAtMs ?? 0;
  return {
    entry: { sessionId: id, cwd, createdAt: at, updatedAt: over.updatedAtMs ?? at } as EntryStub,
    title: over.title,
  };
}

/** 把 fixture 拼成 SessionStore 形状的 stub。 */
function stubStore(stub: { entry: EntryStub; title?: string } | undefined): never {
  return {
    getRaw: () => stub?.entry,
    sessionFor: () =>
      stub?.entry.sessionId !== undefined && stub.entry.cwd !== undefined
        ? { sessionId: stub.entry.sessionId, cwd: stub.entry.cwd }
        : undefined,
    titleFor: () => stub?.title,
    getIdleTimeoutMinutes: () => undefined,
  } as never;
}

function makeCtx(overrides: Partial<CommandContext> = {}): CommandContext {
  return {
    channel: {} as never,
    msg: {
      content: '',
      chatId: 'oc_1',
      messageId: 'om_1',
      senderId: 'ou_1',
      senderName: 'tester',
      chatType: 'p2p',
      rawContentType: 'text',
      resources: [],
      mentions: [],
      mentionAll: false,
      mentionedBot: false,
      createTime: 0,
    },
    scope: 'oc_1',
    chatMode: 'p2p',
    sessions: stubStore(sessionStub()),
    workspaces: {
      cwdFor: () => '/home/proj',
      listNamed: () => ({ futu: '/home/futu' }),
    } as never,
    agent: {} as never,
    activeRuns: {
      has: () => false,
    } as never,
    controls: {
      cfg: {
        accounts: { app: { id: 'cli_x', secret: 's', tenant: 'feishu' } },
        preferences: { ompModel: 'futu/deepseek-v4-flash-0731', ompThinking: 'high' },
      },
    } as never,
    ...overrides,
  } as CommandContext;
}

describe('renderContext', () => {
  it('includes scope, cwd, session, model and thinking', () => {
    const out = renderContext(makeCtx());
    expect(out).toContain('聊天窗口');
    expect(out).toContain('/home/proj');
    expect(out).toContain('019f0000-0000-7000-0000-000000000000'); // full session id
    expect(out).toContain('futu/deepseek-v4-flash-0731');
    expect(out).toContain('high');
  });

  it('marks running state', () => {
    const out = renderContext(makeCtx({ activeRuns: { has: () => true } as never }));
    expect(out).toContain('任务状态');
    expect(out).toContain('有任务正在执行');
  });

  it('shows topic tag for topic scope', () => {
    const out = renderContext(makeCtx({ chatMode: 'topic' }));
    expect(out).toContain('话题独立会话');
  });

  it('falls back to OMP defaults when model/thinking unset', () => {
    const ctx = makeCtx();
    ctx.controls = {
      cfg: {
        accounts: { app: { id: 'cli_x', secret: 's', tenant: 'feishu' } },
        preferences: {},
      },
    } as never;
    const out = renderContext(ctx);
    expect(out).toContain('跟随 OMP 默认');
  });

  it('shows a quick-dir only when it matches the current cwd', () => {
    const noMatch = renderContext(makeCtx()); // cwd /home/proj, futu → /home/futu
    expect(noMatch).toContain('当前目录无快捷方式');
    // Match cwd → futu → /home/proj
    const matched = renderContext(
      makeCtx({ workspaces: { cwdFor: () => '/home/proj', listNamed: () => ({ futu: '/home/proj' }) } as never }),
    );
    expect(matched).toContain('futu');
    expect(matched).not.toContain('当前目录无快捷方式');
  });

  it('shows the session title when set (and nothing when it is not)', () => {
    const titled = renderContext(
      makeCtx({
        sessions: stubStore(sessionStub({ title: '修搜索' })),
      }),
    );
    expect(titled).toContain('**标题**: `修搜索`');

    // 没有名字 → 没有标题行（旧的「未命名」占位会让人以为会话有名字）。
    expect(renderContext(makeCtx())).not.toContain('标题');
  });

  it('shows last conversation time', () => {
    const recent = renderContext(makeCtx());
    expect(recent).toContain('最后活动');
    const fresh = renderContext(
      makeCtx({
        sessions: stubStore(sessionStub({ updatedAtMs: Date.now() })),
      }),
    );
    expect(fresh).toContain('0 秒前');
    // No session → new work session
    const none = renderContext(
      makeCtx({
        sessions: stubStore(undefined),
      }),
    );
    expect(none).toContain('（无，新会话）');
  });

  it('shows conversation start time', () => {
    const started = renderContext(
      makeCtx({
        sessions: stubStore(sessionStub({ updatedAtMs: Date.now(), createdAtMs: Date.now() })),
      }),
    );
    expect(started).toContain('开始');
    expect(started).toContain('今天'); // same-day clock
  });

  it('shows last message and last reply when summary provided', () => {
    const out = renderContext(makeCtx(), { lastMessage: '用户最后问题', lastReply: '助手最后回复' });
    expect(out).toContain('最后消息');
    expect(out).toContain('用户最后问题');
    expect(out).toContain('最后回复');
    expect(out).toContain('助手最后回复');
  });

  it('omits last message and reply when summary absent', () => {
    const out = renderContext(makeCtx());
    expect(out).not.toContain('最后消息');
    expect(out).not.toContain('最后回复');
  });

  it('标题只认 /rename 起的名字：没有就不显示这一行', () => {
    const named = renderContext(
      makeCtx({
        sessions: stubStore(sessionStub({ title: '修搜索' })),
      }),
      {},
    );
    expect(named).toContain('**标题**: `修搜索`');

    // 无名会话：不能拿「最后一条用户消息」冒充标题（用户会以为那句就是会话名）。
    const unnamed = renderContext(makeCtx(), {
      lastMessage: '进行运行编译以及测试',
      lastReply: '**编译 + 测试 + 运行……**',
    });
    expect(unnamed).not.toContain('标题');
    expect(unnamed).not.toContain('未命名');
    // 最后消息照旧单独一行（它本来就该在那一行）。
    expect(unnamed).toContain('**最后消息**');
    expect(unnamed).toContain('进行运行编译以及测试');
  });

  it('无活跃会话时不崩，会话行提示下一条消息新建', () => {
    const out = renderContext(
      makeCtx({
        sessions: stubStore(undefined),
      }),
    );
    expect(out).toContain('**会话**: （无，下一条消息新建）');
    // 没有会话（自然也没有名字）→ 不渲染标题行。
    expect(out).not.toContain('标题');
    expect(out).toContain('**开始**: （无，新会话）');
  });

  it('以单个会话为单位渲染，不再有工作会话/段', () => {
    const out = renderContext(makeCtx());
    // 身份 = 会话 id（🧠 会话 行），名字落在当前对话上。
    expect(out).toContain('🧠 **会话**');
    // 无名会话没有标题行 —— 别拿最后一条用户消息冒充。
    expect(out).not.toContain('标题');
    expect(out).not.toContain('工作会话');
    expect(out).not.toContain('当前段');
    expect(out).not.toContain('段');
    expect(out).not.toContain('个目录');
  });
});

describe('extractUserInput', () => {
  it('extracts real user text after the last bridge context', () => {
    expect(extractUserInput('<bridge_context>\nchat_id: oc_1\n</bridge_context>\n你是谁')).toBe('你是谁');
  });

  it('returns empty for system-prompt-only frames', () => {
    const sys = '# feishu-omp-bridge 运行约定\n你正在 feishu-omp-bridge 里运行：把飞书消息桥到本地 omp。\n<bridge_context>\nchat_id: oc_1\n</bridge_context>';
    expect(extractUserInput(sys)).toBe('');
  });

  it('returns empty for empty input', () => {
    expect(extractUserInput('')).toBe('');
  });

  it('strips quoted_message blocks, keeping only the real user input', () => {
    const frame =
      '<bridge_context>\nchat_id: oc_1\n</bridge_context>\n' +
      '<quoted_message id="om_x" sender_id="cli_a" type="interactive">\n' +
      '被引用的卡片内容\n' +
      '</quoted_message>\n' +
      '帮我看看这个';
    expect(extractUserInput(frame)).toBe('帮我看看这个');
  });

  it('returns empty when the user only quoted without typing', () => {
    const frame =
      '<bridge_context>\nchat_id: oc_1\n</bridge_context>\n' +
      '<quoted_message id="om_x" sender_id="cli_a" type="text">\n' +
      '被引用的消息\n' +
      '</quoted_message>';
    expect(extractUserInput(frame)).toBe('');
  });
});
