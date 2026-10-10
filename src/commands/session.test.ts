import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { CommandContext } from './index';
import { extractUserInput, renderContext } from './session';
import { WorkSessionStore } from '../session/work-store';
import type { WorkSegment, WorkSession } from '../session/work-session';

const ULID = '019f0000-0000-7000-0000-000000000000';

/** A WorkSession stub with the current segment set (what /ctx reads). */
function workSession(
  over: {
    id?: string;
    title?: string;
    cwd?: string;
    createdAtMs?: number;
    lastActiveAtMs?: number;
    currentSegmentId?: string;
    segments?: WorkSegment[];
  } = {},
): WorkSession {
  const id = over.id ?? ULID;
  const cwd = over.cwd ?? '/home/proj';
  const at = over.createdAtMs ?? 0;
  const seg = (sessionId: string, segCwd: string, segAt: number): WorkSegment => ({
    sessionId,
    cwd: segCwd,
    startedAtMs: segAt,
    lastActiveAtMs: segAt,
  });
  return {
    id,
    scope: 'oc_1',
    cwd,
    ...(over.title !== undefined ? { title: over.title } : {}),
    createdAtMs: at,
    lastActiveAtMs: over.lastActiveAtMs ?? at,
    currentSegmentId: over.currentSegmentId ?? id,
    segments: over.segments ?? [seg(id, cwd, at)],
  };
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
    workSessions: {
      activeWorkSession: () => workSession(),
      titleFor: () => undefined,
      getIdleTimeoutMinutes: () => undefined,
    } as never,
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

  it('shows the session title when set', () => {
    const titled = renderContext(
      makeCtx({
        workSessions: {
          activeWorkSession: () => workSession({ title: '修搜索' }),
          getIdleTimeoutMinutes: () => undefined,
        } as never,
      }),
    );
    expect(titled).toContain('**标题**: `修搜索`');

    const untitled = renderContext(makeCtx());
    expect(untitled).toContain('**标题**: `未命名`');
  });

  it('shows last conversation time', () => {
    const recent = renderContext(makeCtx());
    expect(recent).toContain('最后活动');
    const fresh = renderContext(
      makeCtx({
        workSessions: {
          activeWorkSession: () => workSession({ lastActiveAtMs: Date.now() }),
          getIdleTimeoutMinutes: () => undefined,
        } as never,
      }),
    );
    expect(fresh).toContain('0 秒前');
    // No session → new work session
    const none = renderContext(
      makeCtx({
        workSessions: {
          activeWorkSession: () => undefined,
          getIdleTimeoutMinutes: () => undefined,
        } as never,
      }),
    );
    expect(none).toContain('（无，新工作会话）');
  });

  it('shows conversation start time', () => {
    const started = renderContext(
      makeCtx({
        workSessions: {
          activeWorkSession: () => workSession({ lastActiveAtMs: Date.now(), createdAtMs: Date.now() }),
          getIdleTimeoutMinutes: () => undefined,
        } as never,
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
});

describe('renderContext — 以工作会话为单位', () => {
  let root: string;
  let store: WorkSessionStore;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'ctx-ws-'));
    store = new WorkSessionStore(join(root, 'sessions.json'));
    await store.load();
  });

  afterEach(async () => {
    await store.flush();
    await rm(root, { recursive: true, force: true });
  });

  const ctxWith = (over: Partial<CommandContext> = {}): CommandContext =>
    makeCtx({
      workSessions: store,
      controls: { cfg: { preferences: { ompSessionDir: join(root, 'omp') } } } as never,
      ...over,
    });

  it('把工作会话 id、段数与当前段作为身份，OMP id 不再当身份', () => {
    store.bindSegment('oc_1', 'ws-first', root);
    store.bindSegment('oc_1', 'seg-b', root);
    store.bindSegment('oc_1', 'seg-c', root);

    const out = renderContext(ctxWith(), {});

    expect(out).toContain('**工作会话**: `ws-first` _（3 段）_');
    expect(out).toContain('（3 段）');
    expect(out).toContain('**当前段**: `seg-c`');
    // OMP 会话 id 只出现在「当前段」，不再有一条把它当身份的「会话 ID」行。
    expect(out).not.toContain('会话 ID');
  });

  it('标题按 name → 最后一条用户消息 → 未命名 回退', () => {
    store.bindSegment('oc_1', 'ws-first', root);

    store.setTitle('oc_1', '修搜索');
    expect(renderContext(ctxWith(), {})).toContain('**标题**: `修搜索`');

    store.clearTitle('oc_1');
    expect(renderContext(ctxWith(), { lastMessage: '看一下 KMP 导出' })).toContain(
      '**标题**: `看一下 KMP 导出`',
    );

    expect(renderContext(ctxWith(), {})).toContain('**标题**: `未命名`');
  });

  it('跨目录工作会话标注「N 段 · M 个目录」', () => {
    store.bindSegment('oc_1', 'seg-a', join(root, 'a'));
    store.bindSegment('oc_1', 'seg-b', join(root, 'b'));

    const out = renderContext(ctxWith(), {});

    expect(out).toContain('（2 段 · 2 个目录）');
  });

  it('无 activeWorkSession 时不崩且给出新建提示', () => {
    const out = renderContext(ctxWith(), {});

    expect(out).toContain('**工作会话**: （无，下一条消息新建）');
    expect(out).toContain('**当前段**: （无，下一条消息新建）');
    expect(out).toContain('**标题**: `未命名`');
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
