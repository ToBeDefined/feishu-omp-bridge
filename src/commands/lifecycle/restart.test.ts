import { describe, expect, it, vi } from 'vitest';
import type { CommandContext } from '../index';
import { restartHandlers } from './restart';

function makeCtx(realRestart: boolean): CommandContext {
  const send = vi.fn(async () => {});
  return {
    channel: { send },
    msg: { chatId: 'oc_1', messageId: 'om_1' },
    controls: { restartProcess: async () => realRestart },
    scope: 'oc_1',
    chatMode: 'p2p',
  } as unknown as CommandContext;
}

function sentBodies(ctx: CommandContext): string[] {
  const send = ctx.channel.send as unknown as ReturnType<typeof vi.fn>;
  return send.mock.calls.map((c) => (c[1] as { markdown?: string }).markdown ?? '');
}

describe('/restart command', () => {
  it('acks with 🚀 only on in-process fallback (not launchd)', async () => {
    const ctx = makeCtx(false);
    await restartHandlers['/restart']!('', ctx);
    const bodies = sentBodies(ctx);
    expect(bodies.some((b) => b.includes('🔄'))).toBe(true);
    expect(bodies.some((b) => b.includes('🚀'))).toBe(true);
  });

  it('does not send a done ack on a real process restart (process dies)', async () => {
    const ctx = makeCtx(true);
    await restartHandlers['/restart']!('', ctx);
    const bodies = sentBodies(ctx);
    expect(bodies.some((b) => b.includes('🔄'))).toBe(true);
    expect(bodies.some((b) => b.includes('🚀'))).toBe(false);
  });

  it('reports failure when restartProcess throws', async () => {
    const ctx = makeCtx(false);
    (ctx.controls as { restartProcess: () => Promise<boolean> }).restartProcess = async () => {
      throw new Error('boom');
    };
    await restartHandlers['/restart']!('', ctx);
    const bodies = sentBodies(ctx);
    expect(bodies.some((b) => b.includes('❌'))).toBe(true);
  });
});
