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
    expect(out).toContain('scope');
    expect(out).toContain('/home/proj');
    expect(out).toContain('019f0000'); // truncated session id
    expect(out).toContain('futu/deepseek-v4-flash-0731');
    expect(out).toContain('high');
  });

  it('marks running state', () => {
    const out = renderContext(makeCtx({ activeRuns: { has: () => true } as never }));
    expect(out).toContain('运行中');
    expect(out).toContain('是');
  });

  it('shows topic tag for topic scope', () => {
    const out = renderContext(makeCtx({ chatMode: 'topic' }));
    expect(out).toContain('话题独立');
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
});
