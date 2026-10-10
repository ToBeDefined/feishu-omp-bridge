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
    state.blocks.push({ kind: 'thinking', content: '先看调用链', active: true });
    const elements = cardElements(renderCard(state));
    const panels = elements.filter(
      (e): e is Record<string, unknown> =>
        typeof e === 'object' && e !== null && 'tag' in e && e.tag === 'collapsible_panel',
    );
    // interleaved text/tool ×3 then a trailing thinking segment: the last
    // tool run + that thinking merge into ONE row, so 3 top-level panels.
    expect(panels).toHaveLength(3);
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

  it('merges a tool+thinking stretch into one row with both counts', () => {
    const state = longRunState(0);
    state.blocks.push({ kind: 'thinking', content: '有实质内容', active: false });
    state.blocks.push({ kind: 'tool', tool: tool(1) });
    state.blocks.push({ kind: 'tool', tool: { ...tool(2), status: 'error', output: 'boom' } });
    state.blocks.push({ kind: 'tool', tool: { ...tool(3), status: 'running' } });
    const elements = cardElements(renderCard(state));
    const panels = elements.filter(
      (e): e is Record<string, unknown> =>
        typeof e === 'object' && e !== null && 'tag' in e && e.tag === 'collapsible_panel',
    );
    // One merged row: thinking segment + 3-call burst share a single outer row
    // (no text between them), so the card has exactly one top-level panel.
    expect(panels).toHaveLength(1);
    expect(panels[0]).toMatchObject({
      expanded: false,
      border: { color: 'red' },
      header: {
        // The failure count trails the TOOL count, not the thinking count.
        title: { content: '🛠 **工具调用** ×3（1 失败） · 🧠 **思考过程** ×1' },
      },
      elements: [
        // Chronological inside: the thinking segment came before the calls.
        { tag: 'collapsible_panel', header: { title: { content: expect.stringContaining('🧠') } } },
        { tag: 'collapsible_panel', header: { title: { content: expect.stringContaining('✅ **Bash**') } } },
        { tag: 'collapsible_panel', border: { color: 'red' }, header: { title: { content: expect.stringContaining('❌ **Bash**') } } },
        { tag: 'collapsible_panel', header: { title: { content: expect.stringContaining('⏳ **Bash**') } } },
      ],
    });
    // Inner calls keep their merged single-layer body (input + output together;
    // the failed call renders its **Error** fence).
    const groupJson = JSON.stringify(panels[0]);
    expect(groupJson).toContain('Command');
    expect(groupJson).toContain('**Error**');
  });

  it('keeps a tools-only burst and a thinking-only run in their original shapes', () => {
    const panelsOf = (blocks: RunState['blocks']): string[] =>
      cardElements(
        renderCard({ ...longRunState(0), terminal: 'done', footer: null, blocks }),
      )
        .filter(
          (e): e is Record<string, unknown> =>
            typeof e === 'object' && e !== null && 'tag' in e && e.tag === 'collapsible_panel',
        )
        .map((p) => JSON.stringify(p));

    const toolsOnly = panelsOf([
      { kind: 'tool', tool: tool(1) },
      { kind: 'tool', tool: tool(2) },
    ]);
    expect(toolsOnly).toHaveLength(1);
    expect(toolsOnly[0]).toContain('工具调用** ×2');
    expect(toolsOnly[0]).not.toContain('思考过程');

    const thinkingOnly = panelsOf([{ kind: 'thinking', content: '只有一个思考段', active: false }]);
    expect(thinkingOnly).toHaveLength(1);
    expect(thinkingOnly[0]).toContain('思考过程');
    expect(thinkingOnly[0]).not.toContain('工具调用');
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
    // 正文与控制区之间有分割线。
    expect(elements[elements.length - 2]).toMatchObject({ tag: 'hr' });
  });

  it('skips the thinking panel when thinking is a bare placeholder (e.g. ".")', () => {
    const state = longRunState(0);
    state.blocks.push({ kind: 'thinking', content: '.', active: false });
    state.blocks.push({ kind: 'text', content: 'real answer', streaming: false });
    const elements = cardElements(renderCard({ ...state, terminal: 'done' }));
    expect(countByTag(elements, 'collapsible_panel')).toBe(0);
    expect(longMarkdown(elements, 'real')).toBe('real answer');
  });

  it('keeps the thinking panel when thinking has actual substance', () => {
    const state = longRunState(0);
    state.blocks.push({ kind: 'thinking', content: '先核对数字，再追触发方', active: false });
    const elements = cardElements(renderCard({ ...state, terminal: 'done' }));
    expect(countByTag(elements, 'collapsible_panel')).toBe(1);
  });

  it('renders thinking segments interleaved at their chronological positions', () => {
    const state: RunState = { ...longRunState(0), terminal: 'done', footer: null };
    state.blocks.push({ kind: 'thinking', content: '先看A', active: false });
    state.blocks.push({ kind: 'text', content: 'A 的结论', streaming: false });
    state.blocks.push({ kind: 'tool', tool: tool(1) });
    state.blocks.push({ kind: 'thinking', content: '再看B', active: true });
    state.blocks.push({ kind: 'text', content: 'B 的结论', streaming: false });
    const elements = cardElements(renderCard(state));
    // Timeline: 🧠 ×1 → text → 🛠 group → 🧠 ×2 (active) → text.
    const shape = elements
      .filter((e) => typeof e === 'object' && e !== null && 'tag' in e)
      .map((e) => String(e.tag))
      .join(',');
    // thinking · text · (tools+thinking merged) · text
    expect(shape).toBe('collapsible_panel,markdown,collapsible_panel,markdown');
    const panelTitles = elements
      .filter(
        (e): e is Record<string, unknown> =>
          typeof e === 'object' && e !== null && 'tag' in e && e.tag === 'collapsible_panel',
      )
      .map((p) => {
        const header = p.header as { title: { content: string } };
        return header.title.content;
      });
    // [0] the standalone thinking segment; [1] the merged tools+thinking row.
    expect(panelTitles[0]).toContain('思考过程');
    expect(panelTitles[1]).toContain('工具调用** ×1 · 🧠 **思考过程** ×1');
    expect(longMarkdown(elements, 'A 的结论')).toBeDefined();
    expect(longMarkdown(elements, 'B 的结论')).toBeDefined();
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
    state.blocks.push({
      kind: 'thinking',
      content: `thinking\n\n${table(9)}`,
      active: false,
    });
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
