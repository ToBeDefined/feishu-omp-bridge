import type { Block, RunState } from './run-state';
import { codeFence } from './templates';

/**
 * Feishu renders markdown tables as card table components and rejects a card
 * carrying more than five of them:
 *
 *   Failed to create card content, ext=ErrCode: 11310;
 *   ErrMsg: card table number over limit; ErrorValue: table
 *
 * The whole update fails. For a streaming reply that kills the run and strands
 * the user on the "⚠️ 卡片渲染中断" fallback — with content that is otherwise
 * tiny, because a table costs ~10 bytes of JSON but one table slot. Byte and
 * element budgets can never see this, so tables get a budget of their own.
 */
export const CARD_TABLE_BUDGET = 5;

/** Per-card table allowance. Every markdown source a card renders spends from
 *  the same budget, so the first five tables in a card stay tables and later
 *  ones are demoted to fenced code (same text, no table component). */
export type TableBudget = (md: string) => string;

/** `|---|---|`, `|:--|--:|` … A GFM delimiter row. Requires a `|`, which
 *  keeps plain `---` rules and setext underlines out. */
function isDelimiterRow(line: string): boolean {
  const t = line.trim();
  return t.includes('|') && t.includes('-') && /^[\s:|-]+$/.test(t);
}

/**
 * `[firstLine, lastLine]` of every GFM table, in document order. Fenced code
 * is skipped: tool bodies are fenced, and a `|` row inside a fence is not a
 * table for Feishu either.
 */
function findTables(lines: string[]): Array<[number, number]> {
  const tables: Array<[number, number]> = [];
  let fence: string | null = null;
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i] ?? '';
    const marker = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line);
    if (marker) {
      // Open on any fence line; close only on a bare fence at least as long
      // (what `codeFence` guarantees for the content it wraps).
      if (fence === null) fence = marker[1] ?? '';
      else if (
        marker[1]?.[0] === fence[0] &&
        (marker[1]?.length ?? 0) >= fence.length &&
        (marker[2] ?? '').trim() === ''
      ) {
        fence = null;
      }
      continue;
    }
    if (fence !== null) continue;
    // A table is a header row followed by its delimiter row; body rows run
    // until a blank line, a line without a pipe, or the next table's header.
    // Back-to-back tables (no blank line between) are counted separately even
    // though a strict GFM parser folds them into one: over-counting only costs
    // a page break, under-counting gets the card rejected.
    const startsTable = (k: number): boolean => {
      const row = lines[k] ?? '';
      return row.includes('|') && !isDelimiterRow(row) && isDelimiterRow(lines[k + 1] ?? '');
    };
    if (!line.includes('|') || isDelimiterRow(line)) continue;
    if (!isDelimiterRow(lines[i + 1] ?? '')) continue;
    let end = i + 1;
    while (
      end + 1 < lines.length &&
      (lines[end + 1] ?? '').trim() !== '' &&
      (lines[end + 1] ?? '').includes('|') &&
      !startsTable(end + 1)
    ) {
      end += 1;
    }
    tables.push([i, end]);
    i = end;
  }
  return tables;
}

/** Number of tables `md` contributes to a card. */
export function countTables(md: string): number {
  return findTables(md.split('\n')).length;
}

/**
 * Keep the first `budget` tables of `md` as tables and wrap the rest in code
 * fences — the content survives verbatim, Feishu just stops counting it as
 * table components.
 */
export function demoteTables(md: string, budget: number): string {
  const lines = md.split('\n');
  const tables = findTables(lines);
  if (tables.length <= budget) return md;
  const parts: string[] = [];
  let cursor = 0;
  tables.forEach(([start, end], index) => {
    if (index < budget) return;
    const before = lines.slice(cursor, start).join('\n').trim();
    if (before) parts.push(before);
    parts.push(codeFence(lines.slice(start, end + 1).join('\n')));
    cursor = end + 1;
  });
  const after = lines.slice(cursor).join('\n').trim();
  if (after) parts.push(after);
  return parts.join('\n\n');
}

/** A `TableBudget` backed by one card's allowance. */
export function createTableBudget(limit = CARD_TABLE_BUDGET): TableBudget {
  let spent = 0;
  return (md: string): string => {
    const remaining = Math.max(0, limit - spent);
    const tables = countTables(md);
    spent += Math.min(tables, remaining);
    return tables > remaining ? demoteTables(md, remaining) : md;
  };
}

/**
 * Split `md` so `head` carries at most `budget` tables. The cut lands on the
 * header row of the first table past the budget, so a table is never torn in
 * half.
 */
export function splitAtTableBudget(md: string, budget: number): { head: string; tail: string } {
  const lines = md.split('\n');
  const tables = findTables(lines);
  const cut = tables[budget]?.[0];
  if (cut === undefined) return { head: md, tail: '' };
  return { head: lines.slice(0, cut).join('\n'), tail: lines.slice(cut).join('\n') };
}

export interface TablePageSplit {
  /** A state whose blocks a single card may carry: ≤ CARD_TABLE_BUDGET tables. */
  page: RunState;
  /** Blocks the caller must render on the next page, in order. Empty when the
   *  whole state fits in one card. */
  carry: Block[];
}

/**
 * Split a run state at the table budget so the reply's own tables keep
 * rendering as tables: the page keeps everything up to the (budget+1)-th
 * table, the caller carries the rest into the next message (see
 * `streamCardPages`). Tool blocks never carry tables — their bodies are
 * fenced — so a cut always lands in a text block.
 */
export function splitByTableBudget(state: RunState): TablePageSplit {
  let used = 0;
  for (const [i, block] of state.blocks.entries()) {
    const tables = block.kind === 'text' ? countTables(block.content) : 0;
    if (used + tables <= CARD_TABLE_BUDGET) {
      used += tables;
      continue;
    }
    const rest = state.blocks.slice(i + 1);
    if (block.kind === 'text') {
      const { head, tail } = splitAtTableBudget(block.content, CARD_TABLE_BUDGET - used);
      const kept: Block[] = head ? [{ ...block, content: head }] : [];
      const carried: Block[] = tail ? [{ ...block, content: tail }] : [];
      return {
        page: { ...state, blocks: [...state.blocks.slice(0, i), ...kept] },
        carry: [...carried, ...rest],
      };
    }
    return { page: { ...state, blocks: state.blocks.slice(0, i) }, carry: state.blocks.slice(i) };
  }
  return { page: state, carry: [] };
}
