import { describe, expect, it } from 'vitest';
import type { LarkChannel } from '@larksuiteoapi/node-sdk';
import { carryOverBlocks, coalesceLatest, fallbackCard, fallbackContent, cardExceedsBudget, splitByByteBudget, streamCardPages } from './batch';
import type { AgentEvent } from '../agent/types';
import type { RunHandle } from './active-runs';
import type { SessionStore } from '../session/store';
import { initialState, type Block, type RunState } from '../card/run-state';
import { renderCard } from '../card/run-renderer';
import { countTables } from '../card/tables';

/** A 2-column GFM table tagged so tests can tell tables apart. */
function tableMd(n: number): string {
  return `| h${n} | v${n} |\n| --- | --- |\n| ${n} | ${n} |`;
}

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
describe('cardExceedsBudget', () => {
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

/** Markdown of every element of a rendered card, panels included. */
function cardMarkdown(card: object): string[] {
  const elements = (card as { body?: { elements?: unknown[] } }).body?.elements ?? [];
  return elements.flatMap((e) => {
    if (typeof e !== 'object' || e === null) return [];
    const nested = 'elements' in e && Array.isArray(e.elements) ? e.elements : [];
    return [e, ...nested].flatMap((el) =>
      typeof el === 'object' && el !== null && 'content' in el && typeof el.content === 'string'
        ? [el.content]
        : [],
    );
  });
}

describe('streamCardPages', () => {
  it('paginates a table-heavy reply instead of letting Feishu reject it', async () => {
    // Production failure (2026-09-25): one answer with six markdown tables was
    // rejected with ErrCode 11310 "card table number over limit", which killed
    // the run and stranded the user on the "⚠️ 卡片渲染中断" fallback.
    const cards: object[] = [];
    // Per-message card sequences (initial + updates patch one message); the
    // user-visible content is the last card of each call.
    const pages: object[][] = [];
    const channel = {
      stream: async (
        _chatId: string,
        spec: { card: { initial: object; producer: (ctrl: { update(card: object): Promise<void> }) => Promise<void> } },
      ) => {
        const page: object[] = [spec.card.initial];
        pages.push(page);
        cards.push(spec.card.initial);
        await spec.card.producer({ update: async (card) => { cards.push(card); page.push(card); } });
      },
      send: async () => {},
    } as unknown as LarkChannel;
    const events: AgentEvent[] = [
      { type: 'text', delta: Array.from({ length: 12 }, (_, i) => tableMd(i)).join('\n\n') },
      { type: 'done' },
    ];
    const handle = {
      run: {
        events: (async function* () {
          yield* events;
        })(),
        stop: async () => {},
        waitForExit: async () => true,
      },
      interrupted: false,
      pendingUiRequests: new Set<string>(),
      uiTimers: new Map<string, NodeJS.Timeout>(),
    } as unknown as RunHandle;

    await streamCardPages(
      channel, 'oc_x', {}, handle, {} as unknown as SessionStore, 'oc_x', '/tmp',
      undefined, undefined, (s) => s,
    );

    expect(cards.length).toBeGreaterThan(1);
    for (const card of cards) {
      const tables = cardMarkdown(card).reduce((n, md) => n + countTables(md), 0);
      expect(tables).toBeLessThanOrEqual(5);
    }
    // Nothing is dropped AND nothing is demoted: every table reaches the user
    // as a real table component, on whichever page it landed.
    const realTables = new Set<string>();
    for (const md of cards.flatMap(cardMarkdown)) {
      const unfenced = md.replace(/```[\s\S]*?```/g, '');
      for (let i = 0; i < 12; i += 1) {
        if (unfenced.includes(`| h${i} | v${i} |`)) realTables.add(`h${i}`);
      }
    }
    // And nothing is repeated across messages: each table appears in exactly
    // one message's final card (drain pages must not re-render their carry).
    const finals = pages.map((page) => page.at(-1)!);
    const finalText = finals.flatMap(cardMarkdown).join('\n').replace(/```[\s\S]*?```/g, '');
    for (let i = 0; i < 12; i += 1) {
      expect(finalText.split(`| h${i} | v${i} |`).length - 1).toBe(1);
    }
    expect(realTables.size).toBe(12);
  });

  it('paginates a byte-heavy reply so no card crosses the 30KB Feishu cap', async () => {
    // Production failure (2026-09-29): a 36KB card was rejected with ErrCode
    // 200800 (Feishu caps cards at 30KB), killing the run on the fallback.
    // The page-closing push must carry only fitting content — it used to
    // re-send the full overflowing state.
    const cards: object[] = [];
    // Each channel.stream call is one Feishu message; its initial + updates
    // patch THAT message, so the user-visible content is the LAST card per
    // call — repeated paragraphs across those finals are real duplicates.
    const pages: object[][] = [];
    const channel = {
      stream: async (
        _chatId: string,
        spec: { card: { initial: object; producer: (ctrl: { update(card: object): Promise<void> }) => Promise<void> } },
      ) => {
        const page: object[] = [spec.card.initial];
        pages.push(page);
        cards.push(spec.card.initial);
        await spec.card.producer({ update: async (card) => { cards.push(card); page.push(card); } });
      },
      send: async () => {},
    } as unknown as LarkChannel;
    const events: AgentEvent[] = [
      { type: 'text', delta: Array.from({ length: 40 }, (_, i) => `段落 ${i}\n` + '中'.repeat(700)).join('\n\n') },
      { type: 'done' },
    ];
    const handle = {
      run: {
        events: (async function* () {
          yield* events;
        })(),
        stop: async () => {},
        waitForExit: async () => true,
      },
      interrupted: false,
      pendingUiRequests: new Set<string>(),
      uiTimers: new Map<string, NodeJS.Timeout>(),
    } as unknown as RunHandle;

    await streamCardPages(
      channel, 'oc_x', {}, handle, {} as unknown as SessionStore, 'oc_x', '/tmp',
      undefined, undefined, (s) => s,
    );

    expect(pages.length).toBeGreaterThan(1);
    for (const card of cards) {
      // 30KB is Feishu's hard cap; every card the channel saw must fit —
      // page initials, streaming updates, and closing cards alike.
      expect(Buffer.byteLength(JSON.stringify(card), 'utf8')).toBeLessThanOrEqual(30 * 1024);
    }
    // Nothing is dropped: all 40 paragraphs reach the user across messages.
    const finals = pages.map((page) => page.at(-1)!);
    const all = finals.flatMap(cardMarkdown).join('\n');
    for (let i = 0; i < 40; i += 1) {
      expect(all).toContain(`段落 ${i}`);
    }
    // …and nothing is repeated: each paragraph lands in exactly one message.
    // (A drain page must not re-render its carry as both the initial and the
    // final card, and a terminal event's own update must not be re-pushed by
    // the finalize path.)
    for (let i = 0; i < 40; i += 1) {
      expect(all.split(`段落 ${i}\n`).length - 1).toBe(1);
    }
  });
});
