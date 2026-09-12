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

    const handle = activeRuns.register('scope-1', run);
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
    activeRuns.register('scope-1', run);
    let fired = false;
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
