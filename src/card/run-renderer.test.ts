import { describe, expect, it } from 'vitest';
import { renderCard } from './run-renderer';
import { cardExceedsBudget } from './pagination';
import { countTables } from './tables';
import { initialState, reduce, type RunState, type ToolEntry } from './run-state';

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

/** Elements below the constant top-of-card title (`🤖 **OMP**`). The title is
 *  pinned by its own test; element-ORDER tests assert on the state-bearing
 *  elements so they stay readable. */
function cardBody(card: object): unknown[] {
  return cardElements(card).slice(1);
}

/** 运行态底部控制区（右列带 ⏹ 终止的那个 column_set）。 */
function controlBlock(card: object): Record<string, unknown> {
  const found = cardElements(card).filter((e) => JSON.stringify(e).includes('"cmd":"stop"'));
  if (found.length !== 1 || typeof found[0] !== 'object' || found[0] === null) {
    throw new Error(`expected exactly one control block, got ${found.length}`);
  }
  return found[0] as Record<string, unknown>;
}

interface ControlColumns {
  columns: Array<{ width?: string; vertical_align?: string; elements: Array<{ content?: string }> }>;
}

/** 控制区左列的文本行（先用量行，后状态行）。 */
function controlLines(card: object): string[] {
  const col = (controlBlock(card) as unknown as ControlColumns).columns[0];
  if (!col) throw new Error('control block has no left column');
  return col.elements.map((e) => String(e.content ?? ''));
}

/** 控制区右列（⏹ 所在列）。 */
function controlRight(card: object): ControlColumns['columns'][number] {
  const col = (controlBlock(card) as unknown as ControlColumns).columns[1];
  if (!col) throw new Error('control block has no right column');
  return col;
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

/** Top-level notation markdown lines (the card's small grey notes). */
function notationMarkdown(elements: unknown[]): string[] {
  return elements.flatMap((e) => {
    if (typeof e !== 'object' || e === null || !('tag' in e) || !('content' in e)) return [];
    if (e.tag !== 'markdown' || !('text_size' in e) || e.text_size !== 'notation') return [];
    return typeof e.content === 'string' ? [e.content] : [];
  });
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
    const elements = cardBody(renderCard(state));
    // Top-level shape below the title: 段落一 · group ×1 · 段落二 · group ×2 · 段落三.
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
        // Merged title: thinking first, tools last (failure count at the end).
        title: { content: '🧠 **思考** ×1 · 🛠 **工具调用** ×3（1 失败）' },
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

  it('工具术语全卡统一为「工具调用」：合并行与单类行的写法不再打架', () => {
    // 合并行曾是「🧠 思考 ×N · 🛠 工具 ×M」，单类行是「🛠 工具调用 ×N」——
    // 同一个概念两个词，用户以为在说两件事。
    const state = longRunState(0);
    state.blocks.push({ kind: 'thinking', content: '先看调用链', active: false });
    state.blocks.push({ kind: 'tool', tool: tool(1) });
    state.blocks.push({ kind: 'text', content: '中间段落', streaming: false });
    state.blocks.push({ kind: 'tool', tool: tool(2) });
    const json = JSON.stringify(renderCard({ ...state, terminal: 'done', footer: null }));
    expect(json).toContain('🧠 **思考** ×1 · 🛠 **工具调用** ×1');
    expect(json).toContain('🛠 **工具调用** ×1');
    // 旧词（没有「调用」二字）在任何面板标题里都不该再出现。
    expect(json).not.toContain('🛠 **工具** ×');
    // 巡检：工具箱 emoji 全仓未使用，卡片也不引入。
    expect(json).not.toContain('🧰');
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
    const elements = cardBody(card);
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

  it('运行态底部控制区：分割线 + 用量/状态两行，⏹ 终止 与两行垂直居中', () => {
    const state = {
      ...longRunState(3),
      startedAt: 1_000_000,
      endedAt: 1_012_400,
      usage: { inputTokens: 11_100, outputTokens: 1_200, costUsd: 0.01234 },
    };
    const elements = cardElements(renderCard(state));
    const blockIndex = elements.findIndex((e) => JSON.stringify(e).includes('"cmd":"stop"'));
    // 控制区是最后一个元素（用量行、状态行、⏹ 都在这里）。
    expect(blockIndex).toBe(elements.length - 1);
    // 紧挨着一条分割线，正文整段在它上面。
    expect((elements[blockIndex - 1] as { tag: string }).tag).toBe('hr');
    const firstBody = elements.findIndex((e) => JSON.stringify(e).includes('text block 0'));
    expect(firstBody).toBeGreaterThan(0);
    expect(firstBody).toBeLessThan(blockIndex);
    // 左列两行：token/费用在上，`状态 · 用时` 独立成行在下。
    const lines = controlLines(renderCard(state));
    expect(lines).toHaveLength(2);
    expect(lines[0]).toContain('tok');
    expect(lines[0]).toContain('💰');
    expect(lines[1]).toContain('正在输出');
    expect(lines[1]).toContain('⏱ 用时 12.4s');
    expect(lines[1]).not.toContain('tok');
    // 右列是 ⏹，两列都垂直居中 —— 按钮对齐这两行的高度中线。
    const right = controlRight(renderCard(state));
    expect(right.width).toBe('auto');
    expect(right.vertical_align).toBe('center');
    expect(JSON.stringify(right)).toContain('⏹ 终止');
    const { columns } = controlBlock(renderCard(state)) as unknown as ControlColumns;
    expect(columns[0]?.width).toBe('weighted');
    expect(columns[0]?.vertical_align).toBe('center');
  });

  it('没有 usage 时底部控制区只留状态行（不留空占位）', () => {
    const state = { ...longRunState(1), startedAt: 1_000_000, endedAt: 1_012_400 };
    const lines = controlLines(renderCard(state));
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('⏱ 用时 12.4s');
  });

  it('运行卡顶层标题恒定：第一个元素是 heading，且不随状态/心跳变化', () => {
    // 命令卡都带 heading，运行卡以前没有 —— 风格不统一。文案恒定（不带随
    // 会话/状态变化的字段），否则每次心跳刷新标题都会跟着变，视觉上像在闪。
    const running = cardElements(renderCard({ ...longRunState(2), startedAt: 1_000_000 }));
    expect(running[0]).toMatchObject({
      tag: 'markdown',
      content: '🤖 **OMP**',
      text_size: 'heading',
    });
    expect(JSON.stringify(running.at(-1))).toContain('"cmd":"stop"'); // 控制区在卡片末尾
    const done = cardElements(renderCard({ ...longRunState(2), terminal: 'done', footer: null }));
    expect(done[0]).toMatchObject({ content: '🤖 **OMP**' });
    const errored = cardElements(
      renderCard({ ...longRunState(2), terminal: 'error', footer: null, errorMsg: 'boom' }),
    );
    expect(errored[0]).toMatchObject({ content: '🤖 **OMP**' });
    expect(errored[1]).toMatchObject({ content: '❌ **运行失败**' });
  });

  it('运行中的已用时长随时长递增（同一状态不同时刻渲染）', () => {
    const startedAt = 1_000_000;
    const head = (elapsedMs: number): string =>
      controlLines(renderCard({ ...longRunState(1), startedAt, endedAt: startedAt + elapsedMs })).at(-1) ?? '';
    expect(head(0)).toContain('⏱ 用时 0.0s');
    expect(head(12_400)).toContain('⏱ 用时 12.4s');
    expect(head(65_000)).toContain('⏱ 用时 1 分 5 秒');
  });

  it('注入 now：心跳在运行中重渲染同一状态，时长读的是注入的时刻', () => {
    // 心跳定时器就是这么刷新的：状态一个字节没变，只把「现在」喂进去。
    const state: RunState = { ...longRunState(1), startedAt: 1_000_000 };
    const head = (now: number): string =>
      controlLines(renderCard(state, { now })).at(-1) ?? '';
    expect(head(1_000_400)).toContain('⏱ 用时 0.4s');
    expect(head(1_005_400)).toContain('⏱ 用时 5.4s');
    expect(head(1_065_000)).toContain('⏱ 用时 1 分 5 秒');
    // 不传 now 时回退到真实时钟：仍是运行中的控制行，没有崩溃/缺字段。
    expect(JSON.stringify(renderCard(state))).toContain('⏱ 用时');
  });

  it('失败/超时/中断在正文之前给出醒目结果行', () => {
    const blocks: RunState['blocks'] = [
      { kind: 'text', content: '这里是很长的正文', streaming: false },
    ];
    const errored: RunState = {
      ...longRunState(0),
      blocks,
      terminal: 'error',
      footer: null,
      errorMsg: 'boom',
      startedAt: 1_000_000,
      endedAt: 1_002_000,
    };
    const failed = cardBody(renderCard(errored));
    expect(failed[0]).toMatchObject({
      tag: 'markdown',
      content: '❌ **运行失败**',
      text_size: 'heading',
    });
    // 详情保留在正文里（标题只说结果，细节留给这一行）。
    expect(longMarkdown(failed, '⚠️ agent 失败：boom')).toBeDefined();
    expect(failed.findIndex((e) => JSON.stringify(e).includes('很长的正文'))).toBeGreaterThan(0);

    const timedOutCard = renderCard({
      ...errored,
      terminal: 'idle_timeout',
      idleTimeoutMinutes: 5,
      errorMsg: undefined,
    });
    const timedOut = cardBody(timedOutCard);
    expect(timedOut[0]).toMatchObject({
      tag: 'markdown',
      // 全角标点：旧文案的 `无响应,已自动终止` 不再出现。
      content: '⏱ **5 分钟无响应，已自动终止**',
      text_size: 'heading',
    });
    expect(JSON.stringify(timedOutCard)).not.toContain('无响应,');

    const interrupted = renderCard({ ...errored, terminal: 'interrupted', errorMsg: undefined });
    expect(cardBody(interrupted)[0]).toMatchObject({
      tag: 'markdown',
      content: '⏹ **已被中断**',
      text_size: 'heading',
    });
    expect(JSON.stringify(interrupted)).not.toContain('_⏹ 已被中断_');
    // 标题这条 heading 与状态 heading 并存：标题恒在，结果行紧随其后。
    expect(cardElements(interrupted)[0]).toMatchObject({ content: '🤖 **OMP**' });
  });

  it('终态脚注显示用时/token/费用，缺哪个省哪个', () => {
    const base: RunState = {
      ...longRunState(0),
      terminal: 'done',
      footer: null,
      startedAt: 1_000_000,
      endedAt: 1_012_400,
    };
    base.blocks.push({ kind: 'text', content: '正文', streaming: false });

    expect(
      notationMarkdown(
        cardElements(
          renderCard({ ...base, usage: { inputTokens: 11_100, outputTokens: 1_200, costUsd: 0.01234 } }),
        ),
      ),
    ).toContain('⏱ 用时 12.4s · 🧮 12.3k tok（入 11.1k / 出 1.2k） · 💰 $0.0123');

    // 脚注排在正文之后。
    const elements = cardElements(renderCard({ ...base, usage: { costUsd: 0.01234 } }));
    expect(elements.findIndex((e) => JSON.stringify(e).includes('用时 12.4s'))).toBeGreaterThan(
      elements.findIndex((e) => JSON.stringify(e).includes('正文')),
    );

    // 只报了输出侧：不臆造「入 0」。
    expect(notationMarkdown(cardElements(renderCard({ ...base, usage: { outputTokens: 500 } })))).toContain(
      '⏱ 用时 12.4s · 🧮 500 tok（出 500）',
    );

    // 没有 usage：只显示用时，不留空占位。
    const onlyTime = notationMarkdown(cardElements(renderCard(base)));
    expect(onlyTime).toContain('⏱ 用时 12.4s');
    expect(JSON.stringify(onlyTime)).not.toContain('tok');
    expect(JSON.stringify(onlyTime)).not.toContain('$');
  });

  it('没有 usage 也没有起跑时间时不出现脚注', () => {
    const state: RunState = { ...longRunState(0), terminal: 'done', footer: null };
    state.blocks.push({ kind: 'text', content: '正文', streaming: false });
    const elements = cardElements(renderCard(state));
    expect(notationMarkdown(elements).filter((line) => line.includes('用时'))).toEqual([]);
    expect(JSON.stringify(elements)).not.toContain('💰');
  });

  it('运行中脚注不重复时长（时长只在状态行上）', () => {
    const state = {
      ...longRunState(1),
      startedAt: 1_000_000,
      endedAt: 1_012_400,
      usage: { inputTokens: 2_000, outputTokens: 300, costUsd: 0.5 },
    };
    const lines = controlLines(renderCard(state));
    expect(lines).toHaveLength(2);
    // 用量行只有 token 与费用，用时留给下面那行状态。
    expect(lines[0]).toBe('🧮 2.3k tok（入 2k / 出 300） · 💰 $0.5000');
    expect(lines[0]).not.toContain('用时');
    expect(lines[1]).toContain('⏱ 用时 12.4s');
  });

  it('usage 事件经 reduce 进状态后，脚注就带上 token 与费用', () => {
    // batch 收到 usage 后不再只写日志：reduce 进 session.state，卡的终态脚注
    // 因此有东西可显示（这里一路跑到 done，验证接得上）。
    const startedAt = Date.now() - 12_400;
    let state: RunState = { ...initialState, startedAt };
    state = reduce(state, { type: 'text', delta: '正文' });
    state = reduce(state, { type: 'usage', inputTokens: 11_100, outputTokens: 1_200, costUsd: 0.01234 });
    state = reduce(state, { type: 'done' });
    expect(notationMarkdown(cardElements(renderCard(state)))).toContainEqual(
      expect.stringMatching(
        /^⏱ 用时 12\.\ds · 🧮 12\.3k tok（入 11\.1k \/ 出 1\.2k） · 💰 \$0\.0123$/,
      ),
    );
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
    const elements = cardBody(renderCard(state));
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
    expect(panelTitles[1]).toContain('🧠 **思考** ×1 · 🛠 **工具调用** ×1');
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

  it('子代理名放进 code span 不留可见反斜杠（escapeMd 在 `...` 里无效）', () => {
    const state = longRunState(0);
    state.subagents = [
      { id: 'sa-1', agent: 'a_b*reviewer', status: 'completed' },
      { id: 'sa-2', agent: 'with`tick', status: 'started' },
    ];
    const elements = cardElements(renderCard({ ...state, terminal: 'done' }));
    const line = longMarkdown(elements, '✅ 子代理 `a_b*reviewer` _完成_');
    expect(line).toBeDefined();
    // escapeMd 的产物（\_ / \*）不该出现在 code span 里
    expect(JSON.stringify(elements)).not.toContain('a\\_b');
    // 反引号把 span 提前闭合的问题同样由 codeSpan 处理掉
    expect(longMarkdown(elements, "🤖 子代理 `with'tick` _工作中_")).toBeDefined();
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
    const done: RunState = { ...state, terminal: 'done' };
    const card = renderCard(done);
    const elements = cardElements(card);
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
    // …and the demotion is announced instead of silent.
    expect(demoted).toContain('第 6 张及之后的表格已转为代码块');
    // 提示很短：加进来之后卡片仍然在预算内（否则它自己就成了新的超限源）。
    expect(cardExceedsBudget(card, done)).toBe(false);
  });
});

