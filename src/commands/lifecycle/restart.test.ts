import { describe, expect, it, vi } from 'vitest';
import type { CommandContext } from '../index';
import { restartHandlers } from './restart';
import { clearOnlineNotice, markOnlineNotice } from '../../bot/online-notify';

vi.mock('../../bot/online-notify', () => ({ markOnlineNotice: vi.fn(), clearOnlineNotice: vi.fn() }));
vi.mock('../../core/logger', () => ({
  log: { info: vi.fn(), fail: vi.fn(), warn: vi.fn() },
}));

function makeCtx(realRestart: boolean, busy = false): CommandContext {
  const send = vi.fn(async () => {});
  return {
    channel: { send },
    msg: { chatId: 'oc_1', messageId: 'om_1' },
    controls: { restartProcess: async () => realRestart },
    scope: 'oc_1',
    chatMode: 'p2p',
    // 重启前要等 run 排空：默认空闲（排空行为另有单测）；busy=true 模拟有 run 在跑。
    activeRuns: { idle: () => !busy },
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
    expect(markOnlineNotice).toHaveBeenCalledWith('oc_1', 'notify', undefined, undefined);
    expect(clearOnlineNotice).not.toHaveBeenCalled();
  });

  it('acks with 🚀 on the in-process fallback and drops the unconsumed marker', async () => {
    vi.clearAllMocks();
    const ctx = makeCtx(false);
    await restartHandlers['/restart']!('', ctx);
    const bodies = sentBodies(ctx);
    expect(bodies.some((b) => b.includes('🔄'))).toBe(true);
    expect(bodies.some((b) => b.includes('🚀'))).toBe(true);
    expect(clearOnlineNotice).toHaveBeenCalledTimes(1);
  });

  it('force：有 run 在跑也不等排空，立即重启', async () => {
    vi.clearAllMocks();
    const ctx = makeCtx(true, true);
    const spy = vi.fn(async () => true);
    (ctx.controls as { restartProcess: unknown }).restartProcess = spy;
    await restartHandlers['/restart']!('force', ctx);
    // 没等排空才会这么快返回（非强制路径会等满 5 分钟排空上限）。
    expect(spy).toHaveBeenCalledTimes(1);
    expect(markOnlineNotice).toHaveBeenCalledWith('oc_1', 'notify', undefined, undefined);
  });

  it('无法识别的参数：只报用法，不重启也不留标记', async () => {
    vi.clearAllMocks();
    const ctx = makeCtx(true);
    await restartHandlers['/restart']!('now', ctx);
    const bodies = sentBodies(ctx);
    expect(bodies.some((b) => b.includes('无法识别的参数'))).toBe(true);
    expect(markOnlineNotice).not.toHaveBeenCalled();
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
    expect(clearOnlineNotice).toHaveBeenCalledTimes(1);
  });
});
