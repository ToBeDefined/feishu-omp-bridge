import { describe, expect, it } from 'vitest';
import type { AgentEvent } from '../agent/types';
import {
  ERROR_MSG_MAX,
  finalizeIfRunning,
  initialState,
  markIdleTimeout,
  markInterrupted,
  reduce,
} from './run-state';

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

describe('mount notices are not rendered into the card', () => {
  const MOUNT =
    'xd://: mounted feishu_current_context, feishu_send_message, feishu_reply_message, feishu_get_message';
  const notice = (message: string, level?: 'info' | 'warning' | 'error') =>
    ({ type: 'ui_notice', message, level }) as Extract<AgentEvent, { type: 'ui_notice' }>;

  it('drops the info mount notice and leaves streaming text untouched', () => {
    const state = reduce(initialState, { type: 'text', delta: '回答中' });
    const after = reduce(state, notice(MOUNT, 'info'));
    expect(after.blocks).toHaveLength(1);
    expect(after.blocks[0]).toMatchObject({ kind: 'text', content: '回答中', streaming: true });
  });

  it('drops it when OMP omits the level', () => {
    const after = reduce(initialState, notice(MOUNT));
    expect(after.blocks).toHaveLength(0);
  });

  it('keeps other info notices', () => {
    const after = reduce(initialState, notice('model switched to futu/deepseek-v4.1-flash', 'info'));
    expect(after.blocks).toHaveLength(1);
    expect(after.blocks[0]).toMatchObject({ kind: 'text', content: 'ℹ️ model switched to futu/deepseek-v4.1-flash' });
  });

  it('keeps a warning/error with the same text, and text that merely mentions xd://', () => {
    const warned = reduce(initialState, notice(MOUNT, 'warning'));
    expect(warned.blocks).toHaveLength(1);
    expect(warned.blocks[0]).toMatchObject({ kind: 'text', content: `⚠️ ${MOUNT}` });

    const later = reduce(initialState, notice(`failed: ${MOUNT}`, 'info'));
    expect(later.blocks).toHaveLength(1);
    expect(later.blocks[0]).toMatchObject({ kind: 'text', content: `ℹ️ failed: ${MOUNT}` });
  });
});

describe('usage 事件并进运行态', () => {
  const usage = (u: { inputTokens?: number; outputTokens?: number; costUsd?: number }) =>
    ({ type: 'usage', ...u }) as Extract<AgentEvent, { type: 'usage' }>;

  it('一次 run 跨多个 turn：用量求和', () => {
    let state = reduce(initialState, usage({ inputTokens: 100, outputTokens: 10, costUsd: 0.001 }));
    state = reduce(state, usage({ inputTokens: 200, outputTokens: 20, costUsd: 0.002 }));
    expect(state.usage).toEqual({ inputTokens: 300, outputTokens: 30, costUsd: 0.003 });
  });

  it('缺的字段不会凭空补 0', () => {
    let state = reduce(initialState, usage({ outputTokens: 5 }));
    state = reduce(state, usage({ costUsd: 0.5 }));
    expect(state.usage).toEqual({ outputTokens: 5, costUsd: 0.5 });
  });

  it('一次都没报过就没 usage 字段（脚注据此不留空占位）', () => {
    expect(reduce(initialState, { type: 'done' }).usage).toBeUndefined();
  });
});

describe('终态记下结束时间', () => {
  const started = { ...initialState, startedAt: 1_000 };

  it('done / error / 中断 / 超时都带上 endedAt', () => {
    expect(reduce(started, { type: 'done' }).endedAt).toBeGreaterThanOrEqual(1_000);
    expect(reduce(started, { type: 'error', message: 'boom' }).endedAt).toBeGreaterThanOrEqual(1_000);
    expect(markInterrupted(started).endedAt).toBeGreaterThanOrEqual(1_000);
    expect(markIdleTimeout(started, 5).endedAt).toBeGreaterThanOrEqual(1_000);
    expect(finalizeIfRunning(started).endedAt).toBeGreaterThanOrEqual(1_000);
  });

  it('已终态的状态再收尾不会刷新结束时间', () => {
    const done = reduce(started, { type: 'done' });
    expect(finalizeIfRunning(done).endedAt).toBe(done.endedAt);
    expect(markInterrupted(done).endedAt).toBe(done.endedAt);
  });
});
