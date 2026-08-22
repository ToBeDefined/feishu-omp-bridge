import { describe, expect, it } from 'vitest';
import { fallbackBody } from './batch';
import { initialState, type RunState } from '../card/run-state';

describe('fallbackBody', () => {
  const base: RunState = {
    ...initialState,
    blocks: [{ kind: 'text', content: 'hello world', streaming: false }],
    terminal: 'done',
  };

  it('delivers the remaining content when the card stream dies mid-run', () => {
    const body = fallbackBody(base, (s) => s);
    expect(body).toContain('⚠️ 卡片渲染中断');
    expect(body).toContain('hello world');
  });

  it('reports failure when there is nothing left to deliver', () => {
    const body = fallbackBody({ ...base, blocks: [] }, (s) => s);
    expect(body).toContain('⚠️ 回复渲染失败');
    expect(body).not.toContain('hello world');
  });

  it('respects the caller filter (tool blocks hidden when prefs say so)', () => {
    const withTool: RunState = {
      ...base,
      blocks: [
        { kind: 'text', content: 'result', streaming: false },
        { kind: 'tool', tool: { id: 't1', name: 'Bash', input: {}, status: 'done', output: 'ok' } },
      ],
    };
    const body = fallbackBody(withTool, (s) => ({
      ...s,
      blocks: s.blocks.filter((b) => b.kind !== 'tool'),
    }));
    expect(body).toContain('result');
    expect(body).not.toContain('Bash');
  });
});
