import { describe, expect, it } from 'vitest';
import { renderCard } from './run-renderer';
import type { RunState, ToolEntry } from './run-state';

function tool(id: number): ToolEntry {
  return { id: `t${id}`, name: 'Bash', input: { command: `cmd ${id}` }, status: 'done', output: 'ok' };
}

function text(id: number): { kind: 'text'; content: string; streaming: boolean } {
  return { kind: 'text', content: `text block ${id}`, streaming: false };
}

/** Build a long-running-style state: many tools interleaved with text. */
function longRunState(count: number, terminal: RunState['terminal'] = 'running'): RunState {
  const blocks: RunState['blocks'] = [];
  for (let i = 0; i < count; i++) {
    blocks.push(text(i));
    blocks.push({ kind: 'tool', tool: tool(i) });
  }
  return {
    blocks,
    reasoning: { content: '', active: false },
    footer: 'streaming',
    terminal,
    ui: { statuses: {}, widgets: {} },
  };
}

function elementCount(card: object): number {
  const body = (card as { body: { elements: unknown[] } }).body;
  return body.elements.length;
}

describe('renderCard element budget', () => {
  it('collapses many tools into a single summary panel (regression: 60+ tools once 400\'d the card with ErrCode 11310)', () => {
    const card = renderCard(longRunState(60));
    // text blocks (~60) + 1 collapsed summary + 1 latest tool + footer + stop
    // — must stay far below Feishu's element limit instead of growing linearly.
    expect(elementCount(card)).toBeLessThan(100);
    // The collapse path must produce exactly one collapsed summary panel for
    // the historical tools (not 60 individual tool panels).
    const body = (card as { body: { elements: Array<{ tag: string }> } }).body;
    const panels = body.elements.filter((e) => e.tag === 'collapsible_panel');
    expect(panels.length).toBe(2); // summary + latest tool
  });

  it('keeps per-tool panels when only a couple of tools ran', () => {
    const state = longRunState(1);
    const card = renderCard(state);
    const body = (card as { body: { elements: Array<{ tag: string }> } }).body;
    const panels = body.elements.filter((e) => e.tag === 'collapsible_panel');
    expect(panels.length).toBe(1); // single tool, rendered directly
  });

  it('truncates an oversized text block to stay under the per-element limit', () => {
    const state = longRunState(0);
    state.blocks.push({ kind: 'text', content: 'x'.repeat(9000), streaming: false });
    const card = renderCard(state);
    const body = (card as { body: { elements: Array<{ tag: string; content?: string }> } }).body;
    const md = body.elements.find((e) => e.tag === 'markdown' && e.content?.startsWith('xxx'));
    expect(md?.content?.length).toBeLessThan(8100);
    expect(md?.content?.endsWith('…')).toBe(true);
  });
});
