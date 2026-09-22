import { describe, expect, it, vi } from 'vitest';
import type { CommandContext } from '../index';
import { restartHandlers } from './restart';
import { clearOnlineNotify, markOnlineNotify } from '../../bot/online-notify';

vi.mock('../../bot/online-notify', () => ({ markOnlineNotify: vi.fn(), clearOnlineNotify: vi.fn() }));
vi.mock('../../core/logger', () => ({
  log: { info: vi.fn(), fail: vi.fn(), warn: vi.fn() },
}));

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
  it('marks the requesting chat so the boot notice reaches it, and does not ack a real restart', async () => {
    vi.clearAllMocks();
    const ctx = makeCtx(true);
    await restartHandlers['/restart']!('', ctx);
    const bodies = sentBodies(ctx);
    expect(bodies.some((b) => b.includes('🔄'))).toBe(true);
    // The process dies mid-restart: no boot-time notice can be sent from here,
    // so the marker is what tells the relaunched daemon to confirm.
    expect(bodies.some((b) => b.includes('🚀'))).toBe(false);
    expect(markOnlineNotify).toHaveBeenCalledWith('oc_1');
    expect(clearOnlineNotify).not.toHaveBeenCalled();
  });

  it('acks with 🚀 on the in-process fallback and drops the unconsumed marker', async () => {
    vi.clearAllMocks();
    const ctx = makeCtx(false);
    await restartHandlers['/restart']!('', ctx);
    const bodies = sentBodies(ctx);
    expect(bodies.some((b) => b.includes('🔄'))).toBe(true);
    expect(bodies.some((b) => b.includes('🚀'))).toBe(true);
    expect(clearOnlineNotify).toHaveBeenCalledTimes(1);
  });

  it('reports failure when restartProcess throws and drops the marker', async () => {
    vi.clearAllMocks();
    const ctx = makeCtx(false);
    (ctx.controls as { restartProcess: () => Promise<boolean> }).restartProcess = async () => {
      throw new Error('boom');
    };
    await restartHandlers['/restart']!('', ctx);
    const bodies = sentBodies(ctx);
    expect(bodies.some((b) => b.includes('❌'))).toBe(true);
    expect(clearOnlineNotify).toHaveBeenCalledTimes(1);
  });
});
