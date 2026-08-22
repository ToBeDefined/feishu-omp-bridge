import { describe, expect, it } from 'vitest';
import { fallbackCard, fallbackContent } from './batch';
import { initialState, type RunState } from '../card/run-state';

const base: RunState = {
  ...initialState,
  blocks: [{ kind: 'text', content: 'hello world', streaming: false }],
  terminal: 'done',
};

describe('fallbackCard', () => {
  it('builds a minimal schema-2.0 card carrying the remaining content', () => {
    const card = fallbackCard(base, (s) => s) as {
      schema: string;
      body: { elements: Array<{ tag: string; content: string }> };
    };
    expect(card.schema).toBe('2.0');
    expect(card.body.elements).toHaveLength(1);
    expect(card.body.elements[0]?.tag).toBe('markdown');
    expect(card.body.elements[0]?.content).toContain('hello world');
    expect(card.body.elements[0]?.content).toContain('⚠️ 卡片渲染中断');
  });

  it('emits no note/button/panel — a surface Feishu cannot reject', () => {
    const json = JSON.stringify(fallbackCard(base, (s) => s));
    expect(json).not.toContain('"note"');
    expect(json).not.toContain('"button"');
    expect(json).not.toContain('collapsible_panel');
  });
});

describe('fallbackContent', () => {
  it('reports failure when there is nothing left to deliver', () => {
    const body = fallbackContent({ ...base, blocks: [] }, (s) => s);
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
    const body = fallbackContent(withTool, (s) => ({
      ...s,
      blocks: s.blocks.filter((b) => b.kind !== 'tool'),
    }));
    expect(body).toContain('result');
    expect(body).not.toContain('Bash');
  });
});
