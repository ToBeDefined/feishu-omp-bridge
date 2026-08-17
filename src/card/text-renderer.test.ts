import { describe, expect, it } from 'vitest';
import { initialState, markIdleTimeout, markInterrupted, reduce } from './run-state';
import { renderText } from './text-renderer';
import type { AgentEvent } from '../agent/types';

describe('renderText', () => {
  it('renders a plain text block', () => {
    const st = reduce(initialState, { type: 'text', delta: '你好，世界' } as AgentEvent);
    expect(renderText(st)).toContain('你好，世界');
  });

  it('renders a tool line with header', () => {
    let st = initialState;
    st = reduce(st, {
      type: 'tool_use',
      id: 't1',
      name: 'Bash',
      input: { command: 'git status' },
    } as AgentEvent);
    expect(renderText(st)).toContain('Bash');
  });

  it('marks interrupted state', () => {
    const st = markInterrupted(initialState);
    expect(renderText(st)).toContain('已被中断');
  });

  it('marks idle timeout with minutes', () => {
    const st = markIdleTimeout(initialState, 5);
    expect(renderText(st)).toContain('5 分钟无响应');
  });

  it('renders running footer while streaming', () => {
    let st = initialState;
    st = reduce(st, { type: 'text', delta: 'x' } as AgentEvent);
    expect(renderText(st)).toContain('正在输出');
  });

  it('renders running footer while thinking', () => {
    const st = { ...initialState, terminal: 'running', footer: 'thinking' } as never;
    expect(renderText(st as never)).toContain('正在思考');
  });

  it('renders running footer while waiting for input', () => {
    const st = { ...initialState, terminal: 'running', footer: 'waiting_input' } as never;
    expect(renderText(st as never)).toContain('等待用户交互');
  });

  it('renders error message', () => {
    const st = { ...initialState, terminal: 'error', errorMsg: 'boom' } as never;
    expect(renderText(st as never)).toContain('boom');
  });

  it('joins multiple blocks with blank lines', () => {
    let st = initialState;
    st = reduce(st, { type: 'text', delta: '第一行' } as AgentEvent);
    st = reduce(st, { type: 'text', delta: '第二行' } as AgentEvent);
    const out = renderText(st);
    expect(out).toContain('第一行');
    expect(out).toContain('第二行');
  });
});
