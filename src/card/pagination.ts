import type { Block, RunState } from './run-state';
import { renderCard, type RunCard } from './run-renderer';
import { renderText } from './text-renderer';
import { createTableBudget } from './tables';

/**
 * Page/budget/fallback rendering for the streamed run card.
 *
 * This module owns "does this card fit, and how do we cut it" — the pure
 * card-layer half of pagination. The orchestration half (event pumping,
 * page lifecycle) lives in bot/batch.ts, which imports from here.
 */

/**
 * Card JSON size budget per page. Feishu caps a card at 30KB — documented as
 * ErrCode 200860 "Card content exceeds limit", and observed in production on
 * 2026-09-29 as 230099 + ErrCode 200800 rejecting a 36,291-byte card. We
 * paginate at 26KB: the wire payload re-serializes the card inside
 * `{"content":"…"}` with every quote escaped (~5% inflation), and pages
 * already carry footer/note chrome a bare content tally undercounts.
 */
const CARD_SIZE_BUDGET = 26 * 1024;
/**
 * Element-count budget per page. Feishu also rejects a streaming card whose
 * body grows past ~50 elements — same ErrCode 11310, observed in production
 * at 55 elements / 44KB (well under the byte budget). Runs with many small
 * tool calls hit this first, so paginate on count too.
 */
const CARD_ELEMENT_BUDGET = 40;

/**
 * Minimum gap between card patches on the same message. Feishu rate-limits
 * per-message updates (230020 "Update the single messages too frequently");
 * un-paced patches during fast streaming tripped it and killed runs on the
 * 渲染中断 fallback (observed 2026-10-05 / 10-09). 1/s leaves ~5x headroom
 * under the documented 5/s limit; latest-wins keeps the final state intact,
 * only the intermediate refresh rate drops.
 */
export const CARD_UPDATE_MIN_INTERVAL_MS = 1000;

/**
 * Latest-wins write coalescer. At most one write in flight; newer values
 * overwrite the pending slot. `flush()` waits for in-flight + pending so
 * the last value always lands. Errors surface on the next `push`/`flush`.
 *
 * `minIntervalMs` paces write STARTS at least that far apart (the first
 * write is immediate). Feishu rate-limits updates to a single message —
 * 230020 "Update the single messages too frequently" — and back-to-back
 * card patches during fast streaming trip it, killing the run on the
 * 渲染中断 fallback. The pending slot still collapses bursts, so only
 * latency grows, never lost content.
 */
export function coalesceLatest<T>(
  write: (value: T) => Promise<void>,
  opts: { minIntervalMs?: number } = {},
): {
  push(value: T): void;
  flush(): Promise<void>;
} {
  const minIntervalMs = opts.minIntervalMs ?? 0;
  let lastWriteAt = -Infinity;
  const paced = async (value: T): Promise<void> => {
    const wait = lastWriteAt + minIntervalMs - Date.now();
    if (wait > 0) {
      // Executor form: tsconfig lib is ES2022 (Promise.withResolvers needs ES2024,
      // and the published package still supports Node 20).
      await new Promise<void>((resolve) => setTimeout(resolve, wait));
    }
    lastWriteAt = Date.now();
    await write(value);
  };
  let pending: T | undefined;
  let inFlight: Promise<void> | undefined;
  let failed: unknown;
  const pump = async (): Promise<void> => {
    try {
      while (pending !== undefined) {
        const value = pending;
        pending = undefined;
        await paced(value);
      }
    } catch (err) {
      failed = err;
    } finally {
      inFlight = undefined;
      if (pending !== undefined && !failed) inFlight = pump();
    }
  };
  return {
    push(value) {
      if (failed) throw failed;
      pending = value;
      inFlight ??= pump();
    },
    async flush() {
      while (inFlight) await inFlight;
      if (failed) throw failed;
      if (pending !== undefined) {
        const value = pending;
        pending = undefined;
        await paced(value);
      }
    },
  };
}

/**
 * Blocks carried into the next page. Only running tools survive: their
 * `tool_result` may arrive after the page boundary, and clearing them would
 * make `reduce` fail to find the block by id, silently dropping the result.
 * Done tools and text blocks are already rendered on the page being closed.
 */
export function carryOverBlocks(blocks: Block[]): Block[] {
  return blocks.filter((b) => b.kind === 'tool' && b.tool.status === 'running');
}

/** Rough serialized size (UTF-8 bytes) of the content a card will carry. */
function runContentBytes(state: RunState): number {
  let n = 0;
  const add = (s: string): void => {
    n += Buffer.byteLength(s, 'utf8');
  };
  for (const b of state.blocks) {
    if (b.kind === 'text') {
      add(b.content);
    } else if (b.kind === 'thinking') {
      add(b.content.slice(0, 1500));
    } else {
      add(b.tool.output ?? '');
      n += 400; // per-tool collapsible_panel chrome (header/icon/border JSON)
      const input = b.tool.input;
      if (typeof input === 'string') add(input);
      else if (input && typeof input === 'object') {
        for (const v of Object.values(input as Record<string, unknown>)) {
          if (typeof v === 'string') add(v);
        }
      }
    }
  }
  if (state.ui.editorText) add(state.ui.editorText.slice(0, 1200));
  for (const w of Object.values(state.ui.widgets)) {
    for (const line of w.lines ?? []) add(line);
  }
  return n;
}

export function cardExceedsBudget(card: import('./run-renderer').RunCard, state: RunState): boolean {
  if (card.body.elements.length > CARD_ELEMENT_BUDGET) return true;
  // Feishu caps the serialized card in BYTES, not JS string length. CJK is
  // ~3 bytes per char, so a char-based budget undercounted a Chinese answer by
  // 3x — 20k chars is already ~59KB of JSON, at the cap, yet passed as "fine".
  // Skip the stringify until content is actually near the cap.
  if (runContentBytes(state) + 8 * 1024 < CARD_SIZE_BUDGET) return false;
  return Buffer.byteLength(JSON.stringify(card), 'utf8') > CARD_SIZE_BUDGET;
}

/**
 * Split a state so the page's rendered card fits CARD_SIZE_BUDGET. The
 * byte-exceed path used to close the page by re-pushing the FULL state —
 * the very card that had just measured over budget — so Feishu rejected it
 * (30KB cap) and the run died on the "卡片渲染中断" fallback. Mirrors
 * splitByTableBudget: the page keeps the longest fitting prefix of blocks,
 * the carry rides the next page. Only a text block can overflow alone
 * (tool bodies are capped at ~2.5KB by tool-render); it is split at a line
 * boundary, with a hard cut for a pathological single line.
 */
export function splitByByteBudget(
  state: RunState,
  filter: (s: RunState) => RunState,
): { page: RunState; carry: Block[] } {
  // 1KB slack inside the budget for the bottomNote/footer chrome the closing
  // render adds on top of what a plain renderCard produced.
  const limit = CARD_SIZE_BUDGET - 1024;
  const fits = (blocks: Block[]): boolean =>
    Buffer.byteLength(JSON.stringify(renderCard(filter({ ...state, blocks }))), 'utf8') <= limit;

  if (fits(state.blocks)) return { page: state, carry: [] };

  // Longest fitting prefix: shrink from the tail.
  const blocks = [...state.blocks];
  while (blocks.length > 1 && !fits(blocks)) blocks.pop();
  if (fits(blocks)) {
    return { page: { ...state, blocks }, carry: state.blocks.slice(blocks.length) };
  }

  // Solo block still over budget — only text can be (tool bodies are capped
  // at ~2.5KB by tool-render). Split at a line boundary.
  const solo = blocks[0];
  if (!solo || solo.kind !== 'text') {
    return { page: { ...state, blocks }, carry: [] };
  }
  const lines = solo.content.split('\n');
  const head: string[] = [];
  for (const line of lines) {
    const next = [...head, line];
    if (!fits([{ kind: 'text', content: next.join('\n'), streaming: false }])) break;
    head.push(line);
  }
  if (head.length === 0) {
    // Pathological single line larger than the whole page: hard-cut at the
    // largest prefix that fits (UTF-8 safe — JS slices by codepoint).
    let cut = solo.content.length;
    while (cut > 1 && !fits([{ kind: 'text', content: solo.content.slice(0, cut), streaming: false }])) {
      cut = Math.floor(cut / 2);
    }
    return {
      page: {
        ...state,
        blocks: [{ kind: 'text', content: solo.content.slice(0, cut), streaming: false }],
      },
      carry: [
        { kind: 'text', content: solo.content.slice(cut), streaming: false },
        ...state.blocks.slice(1),
      ],
    };
  }
  const headText = head.join('\n');
  return {
    page: { ...state, blocks: [{ kind: 'text', content: headText, streaming: false }] },
    carry: [
      { kind: 'text', content: solo.content.slice(headText.length), streaming: false },
      ...state.blocks.slice(1),
    ],
  };
}

/**
 * Markdown text for the card-stream fallback. When card rendering dies
 * mid-run we deliver whatever the current page holds instead of stranding
 * the user on a forever-running card.
 */
export function fallbackContent(state: RunState, filter: (s: RunState) => RunState): string {
  const text = renderText(filter(state)).trim();
  return text
    ? `⚠️ 卡片渲染中断，剩余内容如下：\n\n${text}`
    : '⚠️ 回复渲染失败。可 /doctor 查看日志。';
}

/**
 * Minimal schema-2.0 card for the fallback: a single markdown element, no
 * panels/buttons/notes — the smallest surface Feishu can reject. It is also
 * table-capped: the content that killed the run is often table-heavy, and a
 * fallback rejected by the same ErrCode 11310 would strand the user on the
 * plain-text path.
 */
export function fallbackCard(state: RunState, filter: (s: RunState) => RunState): object {
  return {
    schema: '2.0',
    config: { summary: { content: '回复（降级）' } },
    body: {
      elements: [{ tag: 'markdown', content: createTableBudget()(fallbackContent(state, filter)) }],
    },
  };
}
