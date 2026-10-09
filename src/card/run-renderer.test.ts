import { describe, expect, it } from 'vitest';
import { renderCard } from './run-renderer';
import { countTables } from './tables';
import { initialState, type RunState, type ToolEntry } from './run-state';

function tool(id: number): ToolEntry {
  return { id: `t${id}`, name: 'Bash', input: { command: `cmd ${id}` }, status: 'done', output: 'ok' };
}

function longRunState(count: number, terminal: RunState['terminal'] = 'running'): RunState {
  const blocks: RunState['blocks'] = [];
  for (let i = 0; i < count; i++) {
    blocks.push({ kind: 'text', content: `text block ${i}`, streaming: false });
    blocks.push({ kind: 'tool', tool: tool(i) });
  }
  return {
    ...initialState,
    subagents: [],
    blocks,
    reasoning: { content: '', active: false },
    footer: 'streaming',
    terminal,
    ui: { statuses: {}, widgets: {} },
  };
}

function cardElements(card: object): unknown[] {
  if (!('body' in card)) throw new Error('card has no body');
  const body = card.body;
  if (typeof body !== 'object' || body === null || !('elements' in body)) {
    throw new Error('card body has no elements');
  }
  if (!Array.isArray(body.elements)) throw new Error('card body elements is not an array');
  return body.elements;
}

function countByTag(elements: unknown[], tag: string): number {
  return elements.filter(
    (e) => typeof e === 'object' && e !== null && 'tag' in e && e.tag === tag,
  ).length;
}



/** Longest markdown content starting with the given prefix, if any. */
function longMarkdown(elements: unknown[], prefix: string): string | undefined {
  return elements.reduce<string | undefined>((acc, e) => {
    if (acc !== undefined) return acc;
    if (typeof e !== 'object' || e === null || !('tag' in e)) return acc;
    if (e.tag !== 'markdown' || !('content' in e)) return acc;
    const c = e.content;
    return typeof c === 'string' && c.startsWith(prefix) ? c : acc;
  }, undefined);
}

describe('renderCard', () => {
  it('renders each consecutive tool burst as one collapsible group row', () => {
    // longRunState interleaves text/tool → each tool is its own ×1 group.
    const card = renderCard(longRunState(8));
    const elements = cardElements(card);
    // 8 group rows at the top level; each group nests its tool panel(s).
    expect(countByTag(elements, 'collapsible_panel')).toBe(8);
  });

  it('keeps interleaved tool groups at their chronological positions', () => {
    const state: RunState = { ...longRunState(0), terminal: 'done', footer: null };
    state.blocks.push({ kind: 'text', content: '段落一', streaming: false });
    state.blocks.push({ kind: 'tool', tool: tool(1) });
    state.blocks.push({ kind: 'text', content: '段落二', streaming: false });
    state.blocks.push({ kind: 'tool', tool: tool(2) });
    state.blocks.push({ kind: 'tool', tool: tool(3) });
    state.blocks.push({ kind: 'text', content: '段落三', streaming: false });
    const elements = cardElements(renderCard(state));
    // Top-level shape: 段落一 · group ×1 · 段落二 · group ×2 · 段落三.
    const shape = elements
      .filter((e) => typeof e === 'object' && e !== null && 'tag' in e)
      .map((e) => String(e.tag))
      .join(',');
    expect(shape).toBe('markdown,collapsible_panel,markdown,collapsible_panel,markdown');
    const titles = elements
      .flatMap((e) =>
        typeof e === 'object' && e !== null && 'header' in e
          ? [JSON.stringify((e as { header: { title: { content: string } } }).header)]
          : [],
      )
      .filter((t) => t.includes('工具调用'));
    expect(titles).toHaveLength(2);
    expect(titles[0]).toContain('×1');
    expect(titles[1]).toContain('×2');
  });

  it('keeps the group row grey and suffix-free when every call succeeded', () => {
    const state = longRunState(0);
    state.blocks.push({ kind: 'tool', tool: tool(1) });
    state.blocks.push({ kind: 'tool', tool: tool(2) });
    const panels = cardElements(renderCard(state)).filter(
      (e): e is Record<string, unknown> =>
        typeof e === 'object' && e !== null && 'tag' in e && e.tag === 'collapsible_panel',
    );
    expect(panels).toHaveLength(1);
    expect(panels[0]).toMatchObject({
      expanded: false,
      border: { color: 'grey' },
      header: { title: { content: expect.stringContaining('×2') } },
    });
    expect(JSON.stringify(panels[0])).not.toContain('失败');
  });

  it('collapses thinking and tool groups by default, with a right-arrow expand icon', () => {
    const state = longRunState(3);
    state.reasoning = { content: '先看调用链', active: true };
    const elements = cardElements(renderCard(state));
    const panels = elements.filter(
      (e): e is Record<string, unknown> =>
        typeof e === 'object' && e !== null && 'tag' in e && e.tag === 'collapsible_panel',
    );
    // 3 single-tool groups + 1 reasoning panel — all start collapsed.
    expect(panels).toHaveLength(4);
    for (const panel of panels) {
      expect(panel).toMatchObject({ expanded: false });
    }
    // Collapsed state points right; expanding rotates it 90° to point down.
    expect(panels[0]).toMatchObject({
      header: {
        icon: { token: 'right-small-ccm_outlined' },
        icon_expanded_angle: 90,
      },
    });
  });

  it('groups consecutive tool calls under one 工具调用 row with failure count', () => {
    const state = longRunState(0);
    state.reasoning = { content: '有实质内容', active: false };
    state.blocks.push({ kind: 'tool', tool: tool(1) });
    state.blocks.push({ kind: 'tool', tool: { ...tool(2), status: 'error', output: 'boom' } });
    state.blocks.push({ kind: 'tool', tool: { ...tool(3), status: 'running' } });
    const elements = cardElements(renderCard(state));
    const panels = elements.filter(
      (e): e is Record<string, unknown> =>
        typeof e === 'object' && e !== null && 'tag' in e && e.tag === 'collapsible_panel',
    );
    // One group for the 3-call burst + 1 reasoning panel (reasoning renders
    // first in the card body, so the group is panels[1]).
    expect(panels).toHaveLength(2);
    expect(panels[1]).toMatchObject({
      expanded: false,
      border: { color: 'red' },
      header: { title: { content: expect.stringContaining('×3（1 失败）') } },
      elements: [
        { tag: 'collapsible_panel', header: { title: { content: expect.stringContaining('✅ **Bash**') } } },
        { tag: 'collapsible_panel', border: { color: 'red' }, header: { title: { content: expect.stringContaining('❌ **Bash**') } } },
        { tag: 'collapsible_panel', header: { title: { content: expect.stringContaining('⏳ **Bash**') } } },
      ],
    });
    // Inner calls keep their merged single-layer body (input + output together;
    // the failed call renders its **Error** fence).
    const groupJson = JSON.stringify(panels[1]);
    expect(groupJson).toContain('Command');
    expect(groupJson).toContain('**Error**');
  });

  it('renders a long text block in full (no silent truncation — reduce splits it first)', () => {
    const state = longRunState(0);
    state.blocks.push({ kind: 'text', content: 'x'.repeat(9000), streaming: false });
    const elements = cardElements(renderCard(state));
    const content = longMarkdown(elements, 'xxx');
    expect(content).toBeDefined();
    // 9000 chars rendered verbatim — truncation would have dropped content.
    expect(content!.length).toBe(9000);
  });


  it('renders page notes as notation markdown (schema 2.0 rejects the `note` tag)', () => {
    const state = longRunState(0);
    state.blocks.push({ kind: 'text', content: 'hello', streaming: false });
    const card = renderCard(
      { ...state, terminal: 'done' },
      {
        topNote: '⬆️ 接上一条消息',
        bottomNote: '⬇️ 内容较长，已分页，下一条消息继续',
      },
    );
    const elements = cardElements(card);
    expect(countByTag(elements, 'note')).toBe(0);
    expect(elements[0]).toMatchObject({
      tag: 'markdown',
      content: '⬆️ 接上一条消息',
      text_size: 'notation',
    });
    expect(elements[elements.length - 1]).toMatchObject({
      tag: 'markdown',
      content: '⬇️ 内容较长，已分页，下一条消息继续',
      text_size: 'notation',
    });
  });

  it('never puts a streaming run card into CardKit streaming mode', () => {
    // streaming_mode switches the client to the cardkit typewriter channel;
    // full-card `im.message.patch` updates are not applied until that mode
    // ends, so a run card carrying it only ever shows its final state.
    expect(JSON.stringify(renderCard(longRunState(1)))).not.toContain('streaming_mode');
    expect(JSON.stringify(renderCard({ ...longRunState(1), terminal: 'done' }))).not.toContain(
      'streaming_mode',
    );
  });

  it('aligns the running status and stop button in one footer row', () => {
    const elements = cardElements(renderCard(longRunState(1)));
    const rows = elements.filter(
      (e): e is Record<string, unknown> =>
        typeof e === 'object' && e !== null && 'tag' in e && e.tag === 'column_set',
    );
    const footerRow = rows.find((r) =>
      JSON.stringify(r).includes('⏹ 终止'),
    );
    expect(footerRow).toBeDefined();
    expect(JSON.stringify(footerRow)).toContain('正在输出');
  });

  it('skips the reasoning panel when thinking is a bare placeholder (e.g. ".")', () => {
    const state = longRunState(0);
    state.reasoning = { content: '.', active: false };
    state.blocks.push({ kind: 'text', content: 'real answer', streaming: false });
    const elements = cardElements(renderCard({ ...state, terminal: 'done' }));
    expect(countByTag(elements, 'collapsible_panel')).toBe(0);
    expect(longMarkdown(elements, 'real')).toBe('real answer');
  });

  it('keeps the reasoning panel when thinking has actual substance', () => {
    const state = longRunState(0);
    state.reasoning = { content: '先核对数字，再追触发方', active: false };
    const elements = cardElements(renderCard({ ...state, terminal: 'done' }));
    expect(countByTag(elements, 'collapsible_panel')).toBe(1);
  });

  it('renders subagent lifecycle lines', () => {
    const state = longRunState(0);
    state.subagents = [
      { id: 'sa-1', agent: 'reviewer', description: 'review auth flow', status: 'started' },
      { id: 'sa-2', agent: 'scout', status: 'failed' },
    ];
    const elements = cardElements(renderCard({ ...state, terminal: 'done' }));
    expect(longMarkdown(elements, '🤖 子代理 `reviewer` — review auth flow _工作中_')).toBeDefined();
    expect(longMarkdown(elements, '❌ 子代理 `scout` _失败_')).toBeDefined();
  });

  it('caps table components per card at the Feishu limit (ErrCode 11310)', () => {
    // A production answer with six markdown tables was rejected wholesale:
    // "card table number over limit". Table count is invisible to the
    // byte/element budgets — six tables are ~1KB of card JSON.
    const table = (n: number): string => `| h${n} |\n| --- |\n| ${n} |`;
    const state = longRunState(0);
    state.blocks.push({
      kind: 'text',
      content: Array.from({ length: 8 }, (_, i) => table(i)).join('\n\n'),
      streaming: false,
    });
    state.reasoning = { content: `thinking\n\n${table(9)}`, active: false };
    const elements = cardElements(renderCard({ ...state, terminal: 'done' }));
    // Every markdown source of the card, panels included: Feishu counts the
    // table components of the whole card.
    const sources = elements.flatMap((e) => {
      if (typeof e !== 'object' || e === null) return [];
      const nested = 'elements' in e && Array.isArray(e.elements) ? e.elements : [];
      return [e, ...nested].flatMap((el) =>
        typeof el === 'object' && el !== null && 'content' in el && typeof el.content === 'string'
          ? [el.content]
          : [],
      );
    });
    expect(sources.reduce((n, md) => n + countTables(md), 0)).toBe(5);
    // The demoted tables keep their text — only the component count drops.
    const demoted = sources.find((md) => md.includes('| h7 |')) ?? '';
    expect(demoted).toContain('```');
  });
});
