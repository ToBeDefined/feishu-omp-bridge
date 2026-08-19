import { describe, expect, it } from 'vitest';
import type { CommandContext } from './index';
import { extractUserInput, renderContext } from './session';

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
    sessions: {
      getRaw: () => ({ sessionId: '019f0000-0000-7000-0000-000000000000', cwd: '/x', updatedAt: 0 }),
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
        sessions: {
          getRaw: () => ({ sessionId: 's1', cwd: '/x', updatedAt: 0, title: '修搜索' }),
          getIdleTimeoutMinutes: () => undefined,
        } as never,
      }),
    );
    expect(titled).toContain('修搜索');

    const untitled = renderContext(makeCtx());
    expect(untitled).not.toContain('标题');
  });

  it('shows last conversation time', () => {
    const recent = renderContext(makeCtx());
    expect(recent).toContain('最后对话');
    const fresh = renderContext(
      makeCtx({
        sessions: {
          getRaw: () => ({ sessionId: '019f0000-0000-7000-0000-000000000000', cwd: '/x', updatedAt: Date.now() }),
          getIdleTimeoutMinutes: () => undefined,
        } as never,
      }),
    );
    expect(fresh).toContain('刚刚');
    // No session → new conversation
    const none = renderContext(
      makeCtx({ sessions: { getRaw: () => undefined, getIdleTimeoutMinutes: () => undefined } as never }),
    );
    expect(none).toContain('（无，新会话）');
  });

  it('shows conversation start time', () => {
    const started = renderContext(
      makeCtx({
        sessions: {
          getRaw: () => ({ sessionId: '019f0000-0000-7000-0000-000000000000', cwd: '/x', updatedAt: Date.now(), createdAt: Date.now() }),
          getIdleTimeoutMinutes: () => undefined,
        } as never,
      }),
    );
    expect(started).toContain('开始对话');
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
