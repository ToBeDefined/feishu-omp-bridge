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
    workSessions: {} as never,
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

  it('routes slash-command aliases to the same handler', async () => {
    // /sessions is /history's alias, /session is /resume's, /s is /search's.
    const aliases: Array<[string, string]> = [
      ['/sessions', '/history'],
      ['/session', '/resume'],
      ['/s', '/search'],
    ];
    for (const [alias, canonical] of aliases) {
      const sent: string[] = [];
      const ctx = makeCtx({
        msg: { ...makeCtx().msg, content: alias },
        channel: { send: async (id: string, msg: { markdown: string }) => void sent.push(msg.markdown) } as never,
        workSessions: { chats: () => [], activeWorkSession: () => undefined, allWorkSessions: () => [] } as never,
        workspaces: { cwdFor: () => '/tmp', listNamed: () => ({}) } as never,
      });
      // Both spellings must be recognized (never "unknown command"), i.e. they
      // resolve to a registered handler rather than falling through to OMP.
      expect(await tryHandleCommand(ctx), `${alias} → ${canonical}`).toBe(true);
    }
  });

  it('denies admin commands for non-admin senders', async () => {
    for (const cmd of ['/config', '/release', '/exec', '/run', '/sessions']) {
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

  it('denies owner-gated commands for non-owner admins', async () => {
    for (const cmd of ['/exec', '/run', '/release']) {
      let sent = false;
      const ctx = makeCtx({
        msg: { ...makeCtx().msg, content: cmd, senderId: 'ou_other_admin' },
        controls: {
          cfg: {
            accounts: { app: { id: 'cli_x', secret: 's', tenant: 'feishu' } },
            preferences: { access: { admins: ['ou_admin', 'ou_other_admin'] } },
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

  it('runCommandHandler denies owner-gated commands for non-owner admins', async () => {
    let sent = false;
    const ctx = makeCtx({
      msg: { ...makeCtx().msg, senderId: 'ou_other_admin' },
      controls: {
        cfg: {
          accounts: { app: { id: 'cli_x', secret: 's', tenant: 'feishu' } },
          preferences: { access: { admins: ['ou_admin', 'ou_other_admin'] } },
        },
      } as never,
      channel: {
        send: async () => {
          sent = true;
        },
      } as never,
    });
    expect(await runCommandHandler('exec', 'echo hi', ctx)).toBe('denied');
    expect(sent).toBe(false);
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
