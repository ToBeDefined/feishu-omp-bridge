import { describe, expect, it, vi } from 'vitest';
import { renderCard } from './run-renderer';
import { countTables } from './tables';
import {
  cardExceedsBudget,
  coalesceLatest,
  carryOverBlocks,
  fallbackCard,
  fallbackContent,
  splitByByteBudget,
} from './pagination';
import { initialState, type Block, type RunState } from './run-state';

/** A 2-column GFM table tagged so tests can tell tables apart. */

const base: RunState = {
  ...initialState,
  blocks: [{ kind: 'text', content: 'hello world', streaming: false }],
  terminal: 'done',
};

describe('cardExceedsBudget', () => {
  it('paginates a CJK answer that is over the byte cap but under the char cap', () => {
    // 20k Chinese chars ≈ 59KB of card JSON: far past Feishu's 30KB card cap,
    // yet only ~20k "chars" — a char-based budget let it through.
    let state: RunState = initialState;
    for (let i = 0; i < 40; i += 1) {
      state = { ...state, blocks: [...state.blocks, { kind: 'text', content: '中'.repeat(500), streaming: false }] };
    }
    const card = renderCard(state);
    expect(Buffer.byteLength(JSON.stringify(card), 'utf8')).toBeGreaterThan(26 * 1024);
    expect(cardExceedsBudget(card, state)).toBe(true);
  });
  it('paginates at the observed production failure size: a 36KB card is over the 30KB Feishu cap', () => {
    // 2026-09-29 incident: a 20-element, 36,291-byte card passed the old 48KB
    // budget and Feishu rejected it (230099 + ErrCode 200800), stranding the
    // run on the "卡片渲染中断" fallback. The budget must trip below that.
    let state: RunState = initialState;
    for (let i = 0; i < 18; i += 1) {
      state = {
        ...state,
        blocks: [
          ...state.blocks,
          { kind: 'tool', tool: { id: `t${i}`, name: 'bash', input: { command: 'x'.repeat(80) }, status: 'done', output: 'y'.repeat(1700) } },
        ],
      };
    }
    const card = renderCard(state);
    const bytes = Buffer.byteLength(JSON.stringify(card), 'utf8');
    expect(bytes).toBeGreaterThan(26 * 1024);
    expect(bytes).toBeLessThan(48 * 1024); // would have passed the old budget
    expect(cardExceedsBudget(card, state)).toBe(true);
  });

  it('does not paginate a small card', () => {
    const card = renderCard(base);
    expect(cardExceedsBudget(card, base)).toBe(false);
  });

  it('stays under budget for a small card', () => {
    expect(cardExceedsBudget(renderCard(base), base)).toBe(false);
  });

  it('flags a card whose text alone exceeds the budget', () => {
    const big: RunState = {
      ...initialState,
      blocks: [{ kind: 'text', content: 'x'.repeat(60 * 1024), streaming: false }],
    };
    expect(cardExceedsBudget(renderCard(big), big)).toBe(true);
  });

  it('accounts for per-tool panel chrome, not just output length', () => {
    // Many short-output tools: the real card JSON is dominated by each
    // tool's collapsible_panel chrome. An estimate that counts only the
    // output length misses the overflow and Feishu rejects the card.
    const blocks: Block[] = Array.from({ length: 100 }, (_, i) => ({
      kind: 'tool',
      tool: { id: `t${i}`, name: 'Bash', input: { command: 'x' }, status: 'done' as const, output: 'x'.repeat(50) },
    }));
    const state: RunState = { ...initialState, blocks };
    expect(JSON.stringify(renderCard(state)).length).toBeGreaterThan(48 * 1024);
    expect(cardExceedsBudget(renderCard(state), state)).toBe(true);
  });
  it('flags a card past the element budget even when bytes stay small', () => {
    // Element-count pagination guards cheap elements: many tiny text blocks
    // stay far under the byte cap while blowing past the element budget.
    // (Tiny tool calls — the original production shape — now carry enough
    // nested-panel chrome that the byte budget trips first, which is the
    // same conservative outcome.)
    const blocks: Block[] = Array.from({ length: 45 }, (_, i) => ({
      kind: 'text' as const,
      content: `hi ${i}`,
      streaming: false,
    }));
    const state: RunState = { ...initialState, blocks };
    const card = renderCard(state);
    expect(JSON.stringify(card).length).toBeLessThan(48 * 1024);
    expect(card.body.elements.length).toBeGreaterThan(40);
    expect(cardExceedsBudget(card, state)).toBe(true);
  });

  it('accepts a card at the element budget boundary', () => {
    const blocks: Block[] = Array.from({ length: 40 }, (_, i) => ({
      kind: 'tool',
      tool: { id: `t${i}`, name: 'Bash', input: { command: 'x' }, status: 'done' as const, output: 'ok' },
    }));
    // terminal: 'done' — a running card also carries footer + stop button.
    const state: RunState = { ...initialState, blocks, terminal: 'done', footer: null };
    expect(cardExceedsBudget(renderCard(state), state)).toBe(false);
  });
});

describe('splitByByteBudget', () => {
  /** Narrowing accessor for the text variant of Block (used at 5 call sites). */
  const textOf = (block: Block | undefined): string => (block?.kind === 'text' ? block.content : '');

  it('closes the page with fitting content and carries the rest', () => {
    const blocks: Block[] = Array.from({ length: 30 }, (_, i) => ({
      kind: 'text',
      content: `block ${i} ` + 'a'.repeat(1200),
      streaming: false,
    }));
    const state: RunState = { ...initialState, blocks };
    const split = splitByByteBudget(state, (s) => s);
    expect(split.carry.length).toBeGreaterThan(0);
    expect(Buffer.byteLength(JSON.stringify(renderCard(split.page)), 'utf8')).toBeLessThanOrEqual(26 * 1024);
    expect(split.page.blocks.length + split.carry.length).toBe(blocks.length);
  });

  it('splits a single oversized multi-line text block at a line boundary', () => {
    const content = Array.from({ length: 300 }, (_, i) => `line ${i} ` + '中'.repeat(200)).join('\n');
    const state: RunState = { ...initialState, blocks: [{ kind: 'text', content, streaming: false }] };
    const split = splitByByteBudget(state, (s) => s);
    expect(split.carry.length).toBeGreaterThan(0);
    expect(textOf(split.page.blocks[0]) + textOf(split.carry[0])).toBe(content);
    expect(Buffer.byteLength(JSON.stringify(renderCard(split.page)), 'utf8')).toBeLessThanOrEqual(26 * 1024);
  });

  it('hard-cuts a pathological single line', () => {
    const content = '中'.repeat(30 * 1024); // one line, ~90KB of UTF-8
    const state: RunState = { ...initialState, blocks: [{ kind: 'text', content, streaming: false }] };
    const split = splitByByteBudget(state, (s) => s);
    expect(split.carry.length).toBeGreaterThan(0);
    expect(textOf(split.page.blocks[0]).length).toBeGreaterThan(0);
    expect(textOf(split.carry[0]).length).toBeGreaterThan(0);
    expect(textOf(split.page.blocks[0]) + textOf(split.carry[0])).toBe(content);
    expect(Buffer.byteLength(JSON.stringify(renderCard(split.page)), 'utf8')).toBeLessThanOrEqual(26 * 1024);
  });

  it('is a no-op for a fitting state', () => {
    const state: RunState = { ...initialState, blocks: [{ kind: 'text', content: 'small', streaming: false }] };
    const split = splitByByteBudget(state, (s) => s);
    expect(split.carry).toEqual([]);
    expect(split.page).toBe(state);
  });
});

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

  it('caps tables at the Feishu limit so the fallback is not rejected too', () => {
    // The content that killed the run is often table-heavy; a fallback card
    // rejected by the same ErrCode 11310 would strand the user on plain text.
    const table = (n: number): string => `| h${n} |\n| --- |\n| ${n} |`;
    const state: RunState = {
      ...base,
      blocks: [
        { kind: 'text', content: Array.from({ length: 7 }, (_, i) => table(i)).join('\n\n'), streaming: false },
      ],
    };
    const card = fallbackCard(state, (s) => s) as {
      body: { elements: Array<{ content: string }> };
    };
    const content = card.body.elements[0]?.content ?? '';
    expect(countTables(content)).toBeLessThanOrEqual(5);
    expect(content).toContain('| h6 |'); // demoted, not dropped
    expect(content).toContain('⚠️ 卡片渲染中断');
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

describe('时钟注入：探测与最终渲染共用同一个 now', () => {
  const limit = 26 * 1024 - 1024; // splitByByteBudget 的页预算（26KB − 1KB chrome 余量）
  const cap = 26 * 1024; // cardExceedsBudget 的硬上限
  const startedAt = 1_000_000;
  // 同一份内容、两个 now：「用时」从 9.4s 变成 10.0s，文本多 1 字节。
  const nowShort = startedAt + 9_400;
  const nowLong = startedAt + 10_000;
  const stateFor = (content: string): RunState => ({
    ...initialState,
    startedAt,
    blocks: [{ kind: 'text', content, streaming: false }],
  });
  const bytesAt = (content: string, now: number): number =>
    Buffer.byteLength(JSON.stringify(renderCard(stateFor(content), { now })), 'utf8');

  /** base 之上补若干个 ASCII 字节，使渲染恰好落在 target 字节上（ASCII 是 1 字节）。 */
  const contentAt = (base: string, target: number, now: number): string => {
    const gap = target - bytesAt(base, now);
    expect(gap).toBeGreaterThanOrEqual(0);
    return base + 'a'.repeat(gap);
  };

  it('fits() 与最终 renderCard 读同一个 now，不再因跨秒多 1 字节而改变分段', () => {
    const content = contentAt('中'.repeat(8000), limit, nowShort);
    expect(bytesAt(content, nowShort)).toBe(limit);
    expect(bytesAt(content, nowLong)).toBe(limit + 1);

    const state = stateFor(content);
    // 系统时钟停在「长」时刻；调用方显式传 nowShort。修复前 splitByByteBudget 内部
    // 的 renderCard 会读 Date.now()（nowLong）→ 探测多 1 字节 → 误判超限去切页。
    vi.useFakeTimers();
    vi.setSystemTime(nowLong);
    try {
      const shortSplit = splitByByteBudget(state, (s) => s, nowShort);
      expect(shortSplit.carry).toEqual([]);
      expect(shortSplit.page).toBe(state);

      const longSplit = splitByByteBudget(state, (s) => s, nowLong);
      expect(longSplit.carry.length).toBeGreaterThan(0);
      // 切出来的页在同一个 now 下确实装得下（探测与最终渲染一致）。
      const pageBytes = Buffer.byteLength(
        JSON.stringify(renderCard(longSplit.page, { now: nowLong })),
        'utf8',
      );
      expect(pageBytes).toBeLessThanOrEqual(limit);
    } finally {
      vi.useRealTimers();
    }
  });

  it('cardExceedsBudget 与同一 now 的 renderCard 字节数一致（26KB 硬上限）', () => {
    const content = contentAt('中'.repeat(8300), cap, nowShort);
    const state = stateFor(content);

    const shortCard = renderCard(state, { now: nowShort });
    expect(Buffer.byteLength(JSON.stringify(shortCard), 'utf8')).toBe(cap);
    expect(cardExceedsBudget(shortCard, state)).toBe(false);

    const longCard = renderCard(state, { now: nowLong });
    expect(Buffer.byteLength(JSON.stringify(longCard), 'utf8')).toBe(cap + 1);
    expect(cardExceedsBudget(longCard, state)).toBe(true);
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

  it('paces writes at least minIntervalMs apart without losing the latest', async () => {
    const seen: number[] = [];
    const stamps: number[] = [];
    const q = coalesceLatest(
      async (v: number) => {
        seen.push(v);
        stamps.push(Date.now());
      },
      { minIntervalMs: 60 },
    );
    for (let i = 0; i < 5; i++) q.push(i);
    await q.flush();
    // Latest-wins coalescing still holds under throttle.
    expect(seen.at(-1)).toBe(4);
    expect(seen.length).toBeLessThan(5);
    // Every write starts at least minIntervalMs after the previous one —
    // this is what keeps Feishu's per-message update rate limit (230020)
    // from tripping during fast streaming.
    for (let i = 1; i < stamps.length; i++) {
      expect(stamps[i]! - stamps[i - 1]!).toBeGreaterThanOrEqual(55);
    }
  });

  it('paces flush-driven writes too', async () => {
    const stamps: number[] = [];
    const q = coalesceLatest(
      async () => {
        stamps.push(Date.now());
      },
      { minIntervalMs: 60 },
    );
    q.push(1);
    await q.flush();
    q.push(2);
    await q.flush();
    expect(stamps).toHaveLength(2);
    expect(stamps[1]! - stamps[0]!).toBeGreaterThanOrEqual(55);
  });
});
