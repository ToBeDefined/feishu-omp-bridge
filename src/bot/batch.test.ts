import { describe, expect, it } from 'vitest';
import { carryOverBlocks, coalesceLatest, fallbackCard, fallbackContent } from './batch';
import { initialState, type Block, type RunState } from '../card/run-state';

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

describe('carryOverBlocks', () => {
  const blocks: Block[] = [
    { kind: 'text', content: 'done text', streaming: false },
    { kind: 'tool', tool: { id: 't1', name: 'Bash', input: {}, status: 'done', output: 'ok' } },
    { kind: 'tool', tool: { id: 't2', name: 'Read', input: {}, status: 'running' } },
  ];

  it('keeps only running tools (their result may land on the next page)', () => {
    const carried = carryOverBlocks(blocks);
    expect(carried).toHaveLength(1);
    expect(carried[0]).toMatchObject({ kind: 'tool', tool: { id: 't2', status: 'running' } });
  });

  it('drops done tools and text blocks (already rendered on the closed page)', () => {
    const carried = carryOverBlocks(blocks);
    const ids = carried.map((b) => (b.kind === 'tool' ? b.tool.id : b.kind));
    expect(ids).not.toContain('t1');
    expect(ids).not.toContain('text');
  });
});

describe('coalesceLatest', () => {
  it('drops superseded values while a write is in flight', async () => {
    const seen: number[] = [];
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    let first = true;
    const q = coalesceLatest(async (v: number) => {
      seen.push(v);
      if (first) {
        first = false;
        await gate;
      }
    });
    q.push(1);
    q.push(2);
    q.push(3);
    release();
    await q.flush();
    expect(seen[0]).toBe(1);
    expect(seen.at(-1)).toBe(3);
    expect(seen).not.toContain(2);
  });

  it('flush delivers the last pending value', async () => {
    const seen: string[] = [];
    const q = coalesceLatest(async (v: string) => {
      seen.push(v);
    });
    q.push('a');
    q.push('b');
    await q.flush();
    expect(seen.at(-1)).toBe('b');
  });

  it('rethrows a failed write on the next push and on flush', async () => {
    const q = coalesceLatest(async () => {
      throw new Error('nope');
    });
    q.push(1);
    await expect(q.flush()).rejects.toThrow('nope');
    expect(() => q.push(2)).toThrow('nope');
  });
});
