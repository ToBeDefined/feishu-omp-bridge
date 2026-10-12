import { describe, expect, it } from 'vitest';
import { initialState, markIdleTimeout, markInterrupted, reduce, type RunState } from './run-state';
import { renderText, splitText } from './text-renderer';
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
    expect(renderText(st)).toContain('5 分钟无响应，已自动终止');
    // 全角标点：半角逗号的旧文案不再出现。
    expect(renderText(st)).not.toContain('无响应,');
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
    // 全角冒号（旧文案是 `agent 失败:boom`）。
    expect(renderText(st as never)).toContain('agent 失败：boom');
    expect(renderText(st as never)).not.toContain('agent 失败:');
  });

  it('失败但没有 errorMsg 时也说一句，不能只给正文', () => {
    const st = { ...initialState, terminal: 'error' } as never;
    expect(renderText(st as never)).toContain('⚠️ agent 失败');
  });

  it('失败的工具调用带上 error body（文本模式没有面板可展开）', () => {
    let st = initialState;
    st = reduce(st, {
      type: 'tool_use',
      id: 't1',
      name: 'Bash',
      input: { command: 'pnpm test' },
    } as AgentEvent);
    st = reduce(st, {
      type: 'tool_result',
      id: 't1',
      isError: true,
      output: 'Command failed: 3 tests failed\n  at src/a.test.ts:12',
    } as AgentEvent);
    const out = renderText(st);
    expect(out).toContain('❌ **Bash**');
    // 原因（error body）原样落到文本里，而不是只剩一个 ❌。
    expect(out).toContain('Command failed: 3 tests failed');
    expect(out).toContain('at src/a.test.ts:12');
  });

  it('成功的工具调用不带上输出（保持一行一条）', () => {
    let st = initialState;
    st = reduce(st, { type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'ls' } } as AgentEvent);
    st = reduce(st, { type: 'tool_result', id: 't1', output: 'a\nb\nc' } as AgentEvent);
    const out = renderText(st);
    expect(out).toContain('✅ **Bash**');
    expect(out).not.toContain('```');
  });

  it('renders widget/status lines with full-width colons', () => {
    const st = {
      ...initialState,
      ui: {
        statuses: { 模式: '计划' },
        widgets: { 待办: { key: '待办', lines: ['第一项'] } },
      },
    } as never;
    const out = renderText(st as never);
    expect(out).toContain('- 模式：计划');
    expect(out).toContain('- 待办：第一项');
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

describe('splitText', () => {
  it('把超长文本按行切成多条消息，一个字都不丢', () => {
    const text = Array.from({ length: 200 }, (_, i) => `段落 ${i} ` + '中'.repeat(60)).join('\n');
    const chunks = splitText(text, 1024);
    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) expect(Buffer.byteLength(chunk, 'utf8')).toBeLessThanOrEqual(1024);
    // 换行符也留在原处：拼回去与原文本完全一致（分段不能丢内容）。
    expect(chunks.join('')).toBe(text);
  });

  it('短文本原样一条，空文本不产生消息', () => {
    expect(splitText('你好', 1024)).toEqual(['你好']);
    expect(splitText('', 1024)).toEqual([]);
  });

  it('单行超长时硬切：不丢字符、不把码点切坏', () => {
    const text = '中'.repeat(1000); // ~3000 bytes on one line
    const chunks = splitText(text, 1024);
    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) expect(Buffer.byteLength(chunk, 'utf8')).toBeLessThanOrEqual(1024);
    expect(chunks.join('')).toBe(text);
    expect(chunks.every((chunk) => !chunk.includes('\uFFFD'))).toBe(true);
  });

  it('超长回退文本分段后仍然带着失败原因', () => {
    let st: RunState = reduce(initialState, { type: 'text', delta: '正文'.repeat(2000) } as AgentEvent);
    st = { ...st, terminal: 'error', errorMsg: 'boom：模型不可用' };
    const text = renderText(st);
    const chunks = splitText(text, 4000);
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.join('')).toBe(text);
    expect(chunks.some((chunk) => chunk.includes('boom：模型不可用'))).toBe(true);
  });
});
