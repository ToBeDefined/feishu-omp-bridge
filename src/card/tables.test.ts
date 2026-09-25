import { describe, expect, it } from 'vitest';
import { countTables, createTableBudget, demoteTables, splitAtTableBudget, splitByTableBudget } from './tables';
import { initialState, type Block, type RunState } from './run-state';

/** A 2-column GFM table tagged so tests can tell tables apart. */
function table(n: number): string {
  return `| h${n}a | h${n}b |\n| --- | --- |\n| ${n} | ${n} |`;
}

function textBlocks(...contents: string[]): Block[] {
  return contents.map((content): Block => ({ kind: 'text', content, streaming: false }));
}

function stateOf(blocks: Block[]): RunState {
  return { ...initialState, blocks };
}

/** Tables a page would render, i.e. across all of its text blocks. */
function pageTables(state: RunState): number {
  return state.blocks.reduce((n, b) => n + (b.kind === 'text' ? countTables(b.content) : 0), 0);
}

describe('countTables', () => {
  it('counts GFM tables, with or without outer pipes', () => {
    expect(countTables(table(1))).toBe(1);
    expect(countTables(`${table(1)}\n\ntext\n\n${table(2)}`)).toBe(2);
    expect(countTables('a | b\n--- | ---\n1 | 2')).toBe(1);
    expect(countTables('| a | b |\n|:--|--:|\n| 1 | 2 |')).toBe(1);
  });

  it('ignores pipe rows inside fenced code (tool bodies are fenced)', () => {
    expect(countTables(['```', table(1), '```'].join('\n'))).toBe(0);
    expect(countTables(['````', '```', table(1), '```', '````'].join('\n'))).toBe(0);
    expect(countTables(['~~~', table(1), '~~~'].join('\n'))).toBe(0);
  });

  it('ignores pipe rows that are not tables', () => {
    expect(countTables('---')).toBe(0); // rule / setext underline, no pipe
    expect(countTables('| only a header |')).toBe(0); // no delimiter row
    expect(countTables('a | b\nplain | row')).toBe(0);
  });
});

describe('demoteTables', () => {
  it('fences every table past the budget and keeps the text', () => {
    const md = [table(1), '', table(2), '', 'tail'].join('\n');
    const out = demoteTables(md, 1);
    expect(countTables(out)).toBe(1);
    expect(out).toContain('| h2a | h2b |');
    expect(out).toContain('```');
    expect(out).toContain('tail');
  });

  it('leaves markdown at or under the budget untouched', () => {
    const md = `${table(1)}\n\ntext`;
    expect(demoteTables(md, 1)).toBe(md);
    expect(demoteTables(md, 5)).toBe(md);
  });
});

describe('createTableBudget', () => {
  it('spends one allowance across every markdown source of a card', () => {
    const budget = createTableBudget();
    for (let i = 0; i < 5; i += 1) expect(countTables(budget(table(i)))).toBe(1);
    const sixth = budget(table(6));
    expect(countTables(sixth)).toBe(0);
    expect(sixth).toContain('| h6a | h6b |'); // content survives as code
  });
});

describe('splitAtTableBudget', () => {
  it('cuts before the first table past the budget', () => {
    const md = [table(1), 'between', table(2)].join('\n');
    const { head, tail } = splitAtTableBudget(md, 1);
    expect(countTables(head)).toBe(1);
    expect(countTables(tail)).toBe(1);
    expect(`${head}\n${tail}`).toBe(md);
  });

  it('returns the input whole when it fits', () => {
    expect(splitAtTableBudget(table(1), 5)).toEqual({ head: table(1), tail: '' });
  });
});

describe('splitByTableBudget', () => {
  it('keeps a state under the budget on one page', () => {
    const state = stateOf(textBlocks(table(1), table(2)));
    const split = splitByTableBudget(state);
    expect(split.page).toBe(state);
    expect(split.carry).toEqual([]);
  });

  it('carries later blocks whole', () => {
    const state = stateOf(textBlocks([table(1), table(2), table(3), table(4), table(5)].join('\n'), table(6)));
    const split = splitByTableBudget(state);
    expect(pageTables(split.page)).toBe(5);
    expect(split.carry).toEqual([{ kind: 'text', content: table(6), streaming: false }]);
  });

  it('splits a single table-heavy block without losing content', () => {
    const content = [table(1), 'mid', table(2), 'mid', table(3), 'mid', table(4), 'mid', table(5), 'mid', table(6)].join('\n');
    const state = stateOf([{ kind: 'text', content, streaming: true }]);
    const split = splitByTableBudget(state);
    expect(pageTables(split.page)).toBe(5);
    expect(split.carry).toHaveLength(1);
    const carried = split.carry[0];
    expect(carried?.kind).toBe('text');
    // The cut lands on a table header, never inside a table, and the two
    // halves reassemble the original text exactly.
    expect(`${(split.page.blocks[0] as { content: string }).content}\n${(carried as { content: string }).content}`).toBe(content);
    // A carried streaming block keeps its flag so later deltas append to it.
    expect((carried as { streaming: boolean }).streaming).toBe(true);
  });

  it('never cuts inside a table, however dense the page', () => {
    // 12 tables in one block: each pass must hand the rest on with progress.
    let carry: Block[] = [{ kind: 'text', content: Array.from({ length: 12 }, (_, i) => table(i)).join('\n'), streaming: false }];
    let pages = 0;
    while (carry.length > 0) {
      const split = splitByTableBudget(stateOf(carry));
      expect(pageTables(split.page)).toBeLessThanOrEqual(5);
      expect(split.carry.length).toBeLessThan(carry.length + 1);
      carry = split.carry;
      pages += 1;
      expect(pages).toBeLessThan(10); // terminates: each page consumes ≥1 table
    }
    expect(pages).toBe(3); // 12 tables at 5 per page
  });
});
