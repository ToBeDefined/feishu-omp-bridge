import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ActiveRuns } from './active-runs';
import { PendingQueue, requeueIfBusy } from './pending-queue';

function msg(id: string) {
  return { messageId: id, content: id } as never;
}

describe('PendingQueue', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('flushes a batch after the debounce window of silence', () => {
    const flushed: Array<{ scope: string; msgs: unknown[] }> = [];
    const q = new PendingQueue(600, (scope, batch) => flushed.push({ scope, msgs: batch }));

    q.push('s', msg('a'));
    q.push('s', msg('b')); // resets the timer

    expect(flushed).toHaveLength(0);
    vi.advanceTimersByTime(599);
    expect(flushed).toHaveLength(0);
    vi.advanceTimersByTime(1);
    expect(flushed).toEqual([{ scope: 's', msgs: [msg('a'), msg('b')] }]);
  });

  it('accumulates messages while blocked and flushes after unblock', () => {
    const flushed: unknown[][] = [];
    const q = new PendingQueue(600, (_scope, batch) => flushed.push(batch));

    q.block('s');
    q.push('s', msg('a'));
    q.push('s', msg('b'));

    // While blocked, no timer runs even after the window elapses.
    vi.advanceTimersByTime(10000);
    expect(flushed).toHaveLength(0);

    // unblock arms a fresh window; only then does the batch flush.
    q.unblock('s');
    vi.advanceTimersByTime(599);
    expect(flushed).toHaveLength(0);
    vi.advanceTimersByTime(1);
    expect(flushed).toEqual([[msg('a'), msg('b')]]);
  });

  it('unblock with an empty queue does not flush', () => {
    const flushed: unknown[][] = [];
    const q = new PendingQueue(600, (_scope, batch) => flushed.push(batch));

    q.block('s');
    q.unblock('s');
    vi.advanceTimersByTime(1000);
    expect(flushed).toHaveLength(0);
  });

  it('cancel returns queued messages and stops the timer', () => {
    const flushed: unknown[][] = [];
    const q = new PendingQueue(600, (_scope, batch) => flushed.push(batch));

    q.push('s', msg('a'));
    const dropped = q.cancel('s');

    expect(dropped).toEqual([msg('a')]);
    vi.advanceTimersByTime(1000);
    expect(flushed).toHaveLength(0);
  });

  it('requeueIfBusy pushes the batch back and arms a fresh window', () => {
    const started: unknown[][] = [];
    const q = new PendingQueue(600, (_scope, batch) => {
      if (requeueIfBusy(q, 's', batch, true)) return;
      started.push(batch);
    });

    q.push('s', msg('a'));
    q.push('s', msg('b'));
    vi.advanceTimersByTime(600);
    expect(started).toHaveLength(0);

    vi.advanceTimersByTime(600);
    expect(started).toHaveLength(0);
  });

  it('flush starts a run once the slot is free', () => {
    const started: unknown[][] = [];
    const activeRuns = new ActiveRuns();
    const occupy = {
      events: (async function* () {})(),
      stop: async () => {},
      waitForExit: async () => true,
    };
    activeRuns.register('s', occupy);

    const q = new PendingQueue(600, (scope, batch) => {
      if (requeueIfBusy(q, scope, batch, activeRuns.has(scope))) return;
      started.push(batch);
    });

    q.push('s', msg('a'));
    vi.advanceTimersByTime(600);
    expect(started).toHaveLength(0);

    activeRuns.unregister('s', occupy);
    vi.advanceTimersByTime(600);
    expect(started).toEqual([[msg('a')]]);
  });

  it('requeueIfBusy is a no-op when idle or the batch is empty', () => {
    const q = new PendingQueue(600, () => {});
    expect(requeueIfBusy(q, 's', [msg('a')], false)).toBe(false);
    expect(requeueIfBusy(q, 's', [], true)).toBe(false);
    vi.advanceTimersByTime(1000);
  });
});
