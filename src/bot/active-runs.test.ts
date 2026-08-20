import { describe, expect, it } from 'vitest';
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

  it('routes compact to the active run', () => {
    const activeRuns = new ActiveRuns();
    const compacts: Array<string | undefined> = [];
    const run: AgentRun = {
      events: emptyEvents(),
      stop: async () => {},
      waitForExit: async () => true,
      compact(customInstructions) {
        compacts.push(customInstructions);
        return true;
      },
    };

    activeRuns.register('scope-1', run);

    expect(activeRuns.compact('scope-1', 'keep the last question')).toBe(true);
    expect(activeRuns.compact('missing')).toBe(false);
    expect(compacts).toEqual(['keep the last question']);
  });
});
