import { describe, expect, it } from 'vitest';
import { ERROR_MSG_MAX, initialState, reduce } from './run-state';

describe('run-state error clamping', () => {
  it('keeps short error messages verbatim', () => {
    const state = reduce(initialState, { type: 'error', message: 'auth required' });
    expect(state.terminal).toBe('error');
    expect(state.errorMsg).toBe('auth required');
  });

  it('keeps the tail of oversized messages — the actionable OMP line comes last', () => {
    // Real shape of an OMP startup failure: Bun prints a huge source frame,
    // then the actual error line at the end of stderr.
    const noise = 'x'.repeat(60_000);
    const message = `${noise}\nerror: Could not restore model ghost-provider/ghost-model`;
    const state = reduce(initialState, { type: 'error', message });
    expect(state.errorMsg).toBe(`…${message.slice(-ERROR_MSG_MAX)}`);
    expect(state.errorMsg).toContain('Could not restore model');
    expect(state.errorMsg!.length).toBe(ERROR_MSG_MAX + 1);
  });
});
