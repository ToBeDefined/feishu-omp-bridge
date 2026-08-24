import { describe, expect, it } from 'vitest';
import type { CommandContext } from './index';
import { runCommandHandler, tryHandleCommand } from './index';

function makeCtx(overrides: Partial<CommandContext> = {}): CommandContext {
  return {
    channel: {} as never,
    msg: {
      content: '/help',
      chatId: 'oc_1',
      messageId: 'om_1',
      senderId: 'ou_admin',
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
    sessions: {} as never,
    workspaces: {} as never,
    agent: {} as never,
    activeRuns: {} as never,
    controls: {
      cfg: {
        accounts: { app: { id: 'cli_x', secret: 's', tenant: 'feishu' } },
        preferences: {},
      },
    } as never,
    ...overrides,
  } as CommandContext;
}

describe('command dispatch', () => {
  it('recognizes slash commands and invokes the handler', async () => {
    let invoked = '';
    const ctx = makeCtx({
      msg: { ...makeCtx().msg, content: '/help' },
    });
    // /help exists in the registry; stub the underlying channel.send.
    ctx.channel = {
      send: async (_to: string, _input: unknown) => {
        invoked = 'sent';
      },
    } as never;
    expect(await tryHandleCommand(ctx)).toBe(true);
    expect(invoked).toBe('sent');
  });

  it('returns false for non-command messages', async () => {
    const ctx = makeCtx({ msg: { ...makeCtx().msg, content: 'plain hello' } });
    expect(await tryHandleCommand(ctx)).toBe(false);
  });

  it('returns false for unknown commands', async () => {
    const ctx = makeCtx({ msg: { ...makeCtx().msg, content: '/nonexistent' } });
    expect(await tryHandleCommand(ctx)).toBe(false);
  });

  it('denies admin commands for non-admin senders', async () => {
    for (const cmd of ['/config', '/release', '/exec', '/run']) {
      let sent = false;
      const ctx = makeCtx({
        msg: { ...makeCtx().msg, content: cmd, senderId: 'ou_other' },
        controls: {
          cfg: {
            accounts: { app: { id: 'cli_x', secret: 's', tenant: 'feishu' } },
            preferences: { access: { admins: ['ou_admin'] } },
          },
        } as never,
        channel: {
          send: async () => {
            sent = true;
          },
        } as never,
      });
      expect(await tryHandleCommand(ctx)).toBe('denied');
      expect(sent).toBe(false);
    }
  });

  it('runCommandHandler routes card button cmds to the right handler', async () => {
    let invoked = '';
    const ctx = makeCtx();
    ctx.channel = {
      send: async () => {
        invoked = 'sent';
      },
    } as never;
    expect(await runCommandHandler('help', '', ctx)).toBe(true);
    expect(invoked).toBe('sent');
  });

  it('swallows handler errors without throwing', async () => {
    // Point /help at a throwing behavior via a synthetic ctx: /help sends a
    // card; make channel.send throw. The wrapper must swallow it.
    const ctx = makeCtx();
    ctx.channel = {
      send: async () => {
        throw new Error('boom');
      },
    } as never;
    await expect(tryHandleCommand(ctx)).resolves.toBe(true);
  });
});
