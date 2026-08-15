import { describe, expect, it } from 'vitest';
import type { CommandContext } from './index';
import { renderContext } from './session';

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
    expect(out).toContain('对话标识');
    expect(out).toContain('/home/proj');
    expect(out).toContain('019f0000'); // truncated session id
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

  it('lists named workspaces', () => {
    const out = renderContext(makeCtx());
    expect(out).toContain('futu');
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
});
