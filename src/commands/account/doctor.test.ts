import { describe, expect, it, vi } from 'vitest';
import type { Mock } from 'vitest';
import { ActiveRuns } from '../../bot/active-runs';
import { doctorHandlers } from './doctor';
import type { CommandContext } from '../index';

const { readRecentLogs } = vi.hoisted(() => ({
  readRecentLogs: vi.fn(async () => '{"level":"info","phase":"ws","event":"connected"}\n'),
}));

// Only the three logger exports doctor.ts uses need to exist.
vi.mock('../../core/logger', () => ({
  readRecentLogs,
  log: { info: vi.fn(), warn: vi.fn(), fail: vi.fn() },
  sanitizeLogsForDoctor: (text: string) => text,
}));

function makeCtx(
  activeRuns: ActiveRuns,
  run: () => unknown,
  chatMode: 'p2p' | 'group' = 'p2p',
): CommandContext {
  const send = vi.fn(async () => {});
  return {
    channel: { send, stream: vi.fn(), rawClient: { im: { v1: { message: { create: vi.fn() } } } } },
    msg: { chatId: 'oc_1', messageId: 'om_1', senderId: 'ou_1', content: '' },
    scope: 'oc_1',
    chatMode,
    workspaces: { cwdFor: () => '/repo' },
    sessions: { resumeFor: () => undefined },
    activeRuns,
    agent: { run },
    controls: { cfg: { preferences: {} } },
    fromCardAction: false,
  } as unknown as CommandContext;
}

describe('/doctor slot handling', () => {
  it('releases the reserved slot when the agent cannot be started', async () => {
    const activeRuns = new ActiveRuns();
    const ctx = makeCtx(activeRuns, () => {
      throw new Error('spawn failed');
    });

    await expect(doctorHandlers['/doctor']!('', ctx)).rejects.toThrow('spawn failed');
    // A leaked claim would make every later message for this scope fail to
    // register — the chat would never run again.
    expect(activeRuns.has('oc_1')).toBe(false);
    expect(activeRuns.claim('oc_1')).toBeDefined();
  });

  it('never registers over an interrupted run that is still reaping', async () => {
    vi.useFakeTimers();
    const activeRuns = new ActiveRuns();
    const live = { events: (async function* () {})(), stop: async () => {}, waitForExit: async () => true };
    activeRuns.register('oc_1', live);
    const started = vi.fn(() => ({
      events: (async function* () {})(),
      stop: async () => {},
      waitForExit: async () => true,
    }));
    const ctx = makeCtx(activeRuns, started);

    const pending = doctorHandlers['/doctor']!('', ctx);
    // Let the handler reach its slot wait and poll a few times.
    await vi.advanceTimersByTimeAsync(300);
    // interrupt() keeps the handle until the old run reaps, so /doctor waits
    // instead of registering over it (which would orphan its UI timers).
    expect(started).not.toHaveBeenCalled();
    expect(activeRuns.has('oc_1')).toBe(true);

    activeRuns.unregister('oc_1', live);
    await vi.advanceTimersByTimeAsync(200);
    await pending;
    expect(started).toHaveBeenCalledTimes(1);
    // ...and releases the slot again once its own run ends.
    expect(activeRuns.has('oc_1')).toBe(false);
    vi.useRealTimers();
  });
});

describe('/doctor 结果卡用量行', () => {
  function runWithEvents(events: unknown[]): () => unknown {
    return () => ({
      events: (async function* () {
        for (const evt of events) yield evt;
      })(),
      stop: async () => {},
      waitForExit: async () => true,
    });
  }

  function createdCard(ctx: CommandContext): string {
    const create = ctx.channel.rawClient.im.v1.message.create as unknown as Mock;
    const call = create.mock.calls[0]![0] as { data: { content: string } };
    return JSON.stringify(JSON.parse(call.data.content));
  }

  it('usage 事件被消费后，结果卡上有用时/用量/费用一行', async () => {
    const activeRuns = new ActiveRuns();
    const ctx = makeCtx(
      activeRuns,
      runWithEvents([
        { type: 'usage', inputTokens: 11100, outputTokens: 1200, costUsd: 0.0123 },
        { type: 'done' },
      ]),
      'group',
    );

    await doctorHandlers['/doctor']!('', ctx);

    const json = createdCard(ctx);
    expect(json).toContain('⏱ 用时');
    expect(json).toContain('🧮 12.3k tok');
    expect(json).toContain('💰 $0.0123');
    expect(activeRuns.has('oc_1')).toBe(false);
  });

  it('没有 usage 时只有时间行，不出现 token/费用占位', async () => {
    const activeRuns = new ActiveRuns();
    const ctx = makeCtx(activeRuns, runWithEvents([{ type: 'done' }]), 'group');

    await doctorHandlers['/doctor']!('', ctx);

    const json = createdCard(ctx);
    expect(json).toContain('⏱ 用时');
    expect(json).not.toContain('🧮');
    expect(json).not.toContain('💰');
  });
});
