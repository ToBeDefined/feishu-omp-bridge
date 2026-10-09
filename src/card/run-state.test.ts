import { describe, expect, it } from 'vitest';
import type { AgentEvent } from '../agent/types';
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

describe('thinking blocks interleave chronologically', () => {
  const think = (delta: string) =>
    ({ type: 'thinking', delta }) as Extract<AgentEvent, { type: 'thinking' }>;

  it('opens a new thinking segment after text/tools and appends within one', () => {
    let state = reduce(initialState, { type: 'text', delta: '先说结论' });
    state = reduce(state, think('看 A'));
    state = reduce(state, think('、再看 B'));
    state = reduce(state, { type: 'tool_use', id: 't1', name: 'Bash', input: {} });
    state = reduce(state, think('收尾检查'));
    const kinds = state.blocks.map((b) => b.kind).join(',');
    expect(kinds).toBe('text,thinking,tool,thinking');
    expect(state.blocks[1]).toMatchObject({ content: '看 A、再看 B', active: false });
    expect(state.blocks[3]).toMatchObject({ content: '收尾检查', active: true });
    expect(state.footer).toBe('thinking');
  });

  it('deactivates the trailing thinking segment on done', () => {
    let state = reduce(initialState, think('推理中'));
    state = reduce(state, { type: 'done' });
    const last = state.blocks.at(-1);
    expect(last).toMatchObject({ kind: 'thinking', active: false, content: '推理中' });
  });
});
