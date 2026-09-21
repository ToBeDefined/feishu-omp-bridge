import { describe, expect, it, vi } from 'vitest';
import type { AgentRun, AgentUiResponse } from '../agent/types';
import { ActiveRuns } from './active-runs';

async function* emptyEvents() {
  return;
}

describe('ActiveRuns OMP UI routing', () => {
  it('routes UI responses to the active run and clears pending request state', () => {
    const activeRuns = new ActiveRuns();
    const responses: Array<{ id: string; response: AgentUiResponse }> = [];
    const run: AgentRun = {
      events: emptyEvents(),
      stop: async () => {},
      waitForExit: async () => true,
      respondToUi(id, response) {
        responses.push({ id, response });
        return true;
      },
    };

    const claim = activeRuns.claim('scope-1');
    const handle = activeRuns.register('scope-1', run, claim);
    if (!handle) throw new Error('register failed');
    handle.pendingUiRequests.add('ui-1');
    let settled = 0;
    handle.onUiSettled = () => {
      settled += 1;
    };

    expect(activeRuns.respondToUi('scope-1', 'ui-1', { confirmed: true })).toBe(true);
    expect(responses).toEqual([{ id: 'ui-1', response: { confirmed: true } }]);
    expect(handle.pendingUiRequests.has('ui-1')).toBe(false);
    expect(settled).toBe(1);
  });

  it('returns false when no active run can accept the response', () => {
    expect(new ActiveRuns().respondToUi('missing', 'ui-1', { cancelled: true })).toBe(false);
  });

  it('routes mid-run prompts to the active run', async () => {
    const activeRuns = new ActiveRuns();
    const prompts: Array<{ kind: string; message: string; imagePaths?: string[] }> = [];
    const run: AgentRun = {
      events: emptyEvents(),
      stop: async () => {},
      waitForExit: async () => true,
      async submitPrompt(kind, message, imagePaths) {
        prompts.push({ kind, message, imagePaths });
        return true;
      },
    };

    activeRuns.register('scope-1', run);

    await expect(activeRuns.submitPrompt('scope-1', 'follow_up', 'next', ['a.png'])).resolves.toBe(true);
    expect(activeRuns.has('scope-1')).toBe(true);
    expect(prompts).toEqual([{ kind: 'follow_up', message: 'next', imagePaths: ['a.png'] }]);
  });

  it('keeps the handle on interrupt so unregister can still fire', () => {
    const activeRuns = new ActiveRuns();
    let stopped = 0;
    const run: AgentRun = {
      events: emptyEvents(),
      stop: async () => { stopped += 1; },
      waitForExit: async () => true,
    };
    activeRuns.register('scope-1', run);
    expect(activeRuns.interrupt('scope-1')).toBe(true);
    expect(activeRuns.has('scope-1')).toBe(true);
    expect(stopped).toBe(1);
    activeRuns.unregister('scope-1', run);
    expect(activeRuns.has('scope-1')).toBe(false);
  });

  it('fires the UI timeout callback when the user never responds', () => {
    vi.useFakeTimers();
    const activeRuns = new ActiveRuns();
    const run: AgentRun = {
      events: emptyEvents(),
      stop: async () => {},
      waitForExit: async () => true,
      respondToUi: () => true,
    };
    activeRuns.register('scope-1', run);
    let fired = false;
    expect(activeRuns.armUiTimeout('scope-1', 'ui-1', 30, () => { fired = true; })).toBe(true);
    vi.advanceTimersByTime(50);
    expect(fired).toBe(true);
    vi.useRealTimers();
  });

  it('cancels the UI timeout when a response arrives first', () => {
    vi.useFakeTimers();
    const activeRuns = new ActiveRuns();
    const run: AgentRun = {
      events: emptyEvents(),
      stop: async () => {},
      waitForExit: async () => true,
      respondToUi: () => true,
    };
    const handle = activeRuns.register('scope-1', run);
    if (!handle) throw new Error('register failed');
    let fired = false;
    // Production order: streamEvents records the request as outstanding before
    // the UI hook arms its timeout.
    handle.pendingUiRequests.add('ui-1');
    activeRuns.armUiTimeout('scope-1', 'ui-1', 30, () => { fired = true; });
    activeRuns.respondToUi('scope-1', 'ui-1', { confirmed: true });
    vi.advanceTimersByTime(50);
    expect(fired).toBe(false);
    vi.useRealTimers();
  });

  it('hasAnyForChat covers the bare chat and any topic scope', () => {
    const activeRuns = new ActiveRuns();
    const run: AgentRun = { events: emptyEvents(), stop: async () => {}, waitForExit: async () => true };
    expect(activeRuns.hasAnyForChat('oc_1')).toBe(false);
    activeRuns.register('oc_1:tid', run);
    expect(activeRuns.has('oc_1')).toBe(false);
    expect(activeRuns.hasAnyForChat('oc_1')).toBe(true);
    expect(activeRuns.hasAnyForChat('oc_2')).toBe(false);
    activeRuns.unregister('oc_1:tid', run);
    expect(activeRuns.hasAnyForChat('oc_1')).toBe(false);
  });

  it('deferCompact and interrupt are no-ops without a handle', () => {
    const activeRuns = new ActiveRuns();
    expect(activeRuns.deferCompact('missing', () => {})).toBe(false);
    expect(activeRuns.interrupt('missing')).toBe(false);
  });

  it('unregister ignores a stale run and does not fire its compact', () => {
    const activeRuns = new ActiveRuns();
    const live: AgentRun = { events: emptyEvents(), stop: async () => {}, waitForExit: async () => true };
    const stale: AgentRun = { events: emptyEvents(), stop: async () => {}, waitForExit: async () => true };
    activeRuns.register('scope-1', live);
    let fired = 0;
    activeRuns.deferCompact('scope-1', () => { fired += 1; });
    activeRuns.unregister('scope-1', stale);
    expect(activeRuns.has('scope-1')).toBe(true);
    expect(fired).toBe(0);
    activeRuns.unregister('scope-1', live);
    expect(fired).toBe(1);
  });

  it('stopAll kills every run and drops deferred compact', async () => {
    const activeRuns = new ActiveRuns();
    let stopped = 0;
    let fired = 0;
    const run: AgentRun = {
      events: emptyEvents(),
      stop: async () => { stopped += 1; },
      waitForExit: async () => true,
    };
    activeRuns.register('scope-1', run);
    activeRuns.deferCompact('scope-1', () => { fired += 1; });
    await activeRuns.stopAll();
    expect(stopped).toBe(1);
    expect(fired).toBe(0);
    expect(activeRuns.has('scope-1')).toBe(false);
    activeRuns.unregister('scope-1', run);
    expect(fired).toBe(0);
  });
});

describe('ActiveRuns slot reservation', () => {
  const makeRun = (): AgentRun => ({
    events: emptyEvents(),
    stop: async () => {},
    waitForExit: async () => true,
  });

  it('a claim reserves the slot before any run exists', () => {
    const activeRuns = new ActiveRuns();
    const claim = activeRuns.claim('scope-1');
    expect(claim).toBeDefined();
    // The scheduler's busy check and the pending queue must see the reservation.
    expect(activeRuns.has('scope-1')).toBe(true);
    expect(activeRuns.hasAnyForChat('scope-1')).toBe(true);
    // A second claim on the same scope is refused rather than queued.
    expect(activeRuns.claim('scope-1')).toBeUndefined();
  });

  it('register never clobbers a live handle', () => {
    const activeRuns = new ActiveRuns();
    const first = activeRuns.register('scope-1', makeRun());
    expect(first).toBeDefined();
    const second = activeRuns.register('scope-1', makeRun());
    expect(second).toBeUndefined();
    expect(activeRuns.has('scope-1')).toBe(true);
  });

  it('register refuses a claim it does not own', () => {
    const activeRuns = new ActiveRuns();
    const mine = activeRuns.claim('scope-1');
    const foreign = activeRuns.claim('scope-2');
    expect(mine).toBeDefined();
    expect(foreign).toBeDefined();
    expect(activeRuns.register('scope-1', makeRun(), foreign)).toBeUndefined();
    expect(activeRuns.register('scope-1', makeRun(), mine)).toBeDefined();
  });

  it('releaseClaim frees the slot for a failed run start', () => {
    const activeRuns = new ActiveRuns();
    const claim = activeRuns.claim('scope-1');
    if (!claim) throw new Error('claim failed');
    activeRuns.releaseClaim(claim);
    expect(activeRuns.has('scope-1')).toBe(false);
    expect(activeRuns.claim('scope-1')).toBeDefined();
  });

  it('claimChat honours a busy topic scope of the same chat', () => {
    const activeRuns = new ActiveRuns();
    activeRuns.register('oc_1:tid', makeRun());
    expect(activeRuns.claimChat('oc_1')).toBeUndefined();
    expect(activeRuns.claimChat('oc_2')).toBeDefined();
  });

  it('waitForFree resolves once the run unregisters', async () => {
    vi.useFakeTimers();
    const activeRuns = new ActiveRuns();
    const run = makeRun();
    activeRuns.register('scope-1', run);
    const waiting = activeRuns.waitForFree('scope-1', 5000);
    activeRuns.unregister('scope-1', run);
    await vi.advanceTimersByTimeAsync(200);
    await expect(waiting).resolves.toBe(true);
    vi.useRealTimers();
  });

  it('waitForFree reports a slot that never frees', async () => {
    vi.useFakeTimers();
    const activeRuns = new ActiveRuns();
    activeRuns.register('scope-1', makeRun());
    const waiting = activeRuns.waitForFree('scope-1', 300);
    await vi.advanceTimersByTimeAsync(400);
    await expect(waiting).resolves.toBe(false);
    vi.useRealTimers();
  });

  it('respondToUi ignores a request that is no longer outstanding', () => {
    const activeRuns = new ActiveRuns();
    const responses: string[] = [];
    const run: AgentRun = {
      events: emptyEvents(),
      stop: async () => {},
      waitForExit: async () => true,
      respondToUi(id) {
        responses.push(id);
        return true;
      },
    };
    const handle = activeRuns.register('scope-1', run);
    if (!handle) throw new Error('register failed');
    handle.pendingUiRequests.add('ui-1');
    expect(activeRuns.respondToUi('scope-1', 'ui-1', { confirmed: true })).toBe(true);
    // The timeout already answered (or the user double-clicked): a second
    // frame for the same id must not reach the child.
    expect(activeRuns.respondToUi('scope-1', 'ui-1', { cancelled: true })).toBe(false);
    expect(responses).toEqual(['ui-1']);
  });

  it('dropUiRequest unblocks the idle watchdog for an undeliverable request', () => {
    const activeRuns = new ActiveRuns();
    const run: AgentRun = { events: emptyEvents(), stop: async () => {}, waitForExit: async () => true };
    const handle = activeRuns.register('scope-1', run);
    if (!handle) throw new Error('register failed');
    let settled = 0;
    handle.onUiSettled = () => { settled += 1; };
    handle.pendingUiRequests.add('ui-1');
    activeRuns.dropUiRequest('scope-1', 'ui-1');
    expect(handle.pendingUiRequests.size).toBe(0);
    expect(settled).toBe(1);
  });
});
