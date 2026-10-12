import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MAX_HISTORY_ENTRIES, recordModelUse, recentModelEntries } from './model-history';

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'model-history-test-'));
});

afterEach(async () => {
  vi.useRealTimers();
  await rm(dir, { recursive: true, force: true });
});

function file(): string {
  return join(dir, 'history.json');
}

/** selector 列表（多数断言只关心顺序与去重）。 */
function selectors(entries: Array<{ selector: string }>): string[] {
  return entries.map((e) => e.selector);
}

/** 写进磁盘的原始 JSON。 */
async function onDisk(): Promise<unknown> {
  return JSON.parse(await readFile(file(), 'utf8')) as unknown;
}

describe('model history (dedup, order, cap)', () => {
  it('records models newest-first, deduped', async () => {
    await recordModelUse('futu/a', file());
    await recordModelUse('futu/b', file());
    await recordModelUse('futu/a', file()); // duplicate — moves back to front
    expect(selectors(await recentModelEntries(5, file()))).toEqual(['futu/a', 'futu/b']);
  });

  it('recentModelEntries returns at most `limit` entries', async () => {
    for (const m of ['futu/a', 'futu/b', 'futu/c', 'futu/d', 'futu/e', 'futu/f']) {
      await recordModelUse(m, file());
    }
    expect(selectors(await recentModelEntries(3, file()))).toEqual(['futu/f', 'futu/e', 'futu/d']);
    expect(await recentModelEntries(10, file())).toHaveLength(6);
  });

  it('caps history at MAX_HISTORY_ENTRIES', async () => {
    for (let i = 0; i < 25; i++) {
      await recordModelUse(`futu/m${i}`, file());
    }
    const all = await recentModelEntries(100, file());
    expect(all).toHaveLength(MAX_HISTORY_ENTRIES);
    expect(all[0]?.selector).toBe('futu/m24'); // newest first
  });

  it('ignores empty model names', async () => {
    await recordModelUse('', file());
    await recordModelUse('   ', file());
    expect(await recentModelEntries(5, file())).toEqual([]);
  });

  it('survives a corrupt file (returns empty, then recovers)', async () => {
    await writeFile(file(), '{not json', 'utf8');
    expect(await recentModelEntries(5, file())).toEqual([]);
    await recordModelUse('futu/a', file());
    expect(selectors(await recentModelEntries(5, file()))).toEqual(['futu/a']);
  });

  it('persists the upgraded shape (selector + at + count), not a bare string[]', async () => {
    await recordModelUse('futu/a', file());
    expect(await onDisk()).toEqual([{ selector: 'futu/a', at: expect.any(Number), count: 1 }]);
  });
});

describe('model history (timestamps & counts)', () => {
  it('accumulates count and refreshes `at` on reuse, keeping one entry', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000_000);
    await recordModelUse('futu/a', file());
    await recordModelUse('futu/b', file());

    vi.setSystemTime(1_600_000);
    await recordModelUse('futu/a', file());

    const entries = await recentModelEntries(10, file());
    expect(entries).toEqual([
      { selector: 'futu/a', at: 1_600_000, count: 2 },
      { selector: 'futu/b', at: 1_000_000, count: 1 },
    ]);
  });

  it('keeps the accumulated count on the surviving entry after the cap trims others', async () => {
    for (let i = 0; i < 3; i++) await recordModelUse('futu/keep', file());
    for (let i = 0; i < MAX_HISTORY_ENTRIES; i++) await recordModelUse(`futu/m${i}`, file());
    const kept = await recentModelEntries(100, file());
    expect(kept).toHaveLength(MAX_HISTORY_ENTRIES);
    // futu/keep 用满 3 次后被挤出前 20；它的计数跟着条目一起走，不会遗留在别人身上。
    expect(kept.some((e) => e.selector === 'futu/keep')).toBe(false);
    expect(kept.every((e) => e.count === 1)).toBe(true);
  });
});

describe('model history (selector normalisation)', () => {
  it('treats `futu/x:thinking` and `futu/x` as the same entry', async () => {
    await recordModelUse('futu/x:thinking', file());
    await recordModelUse('futu/x', file());
    expect(await recentModelEntries(5, file())).toEqual([
      { selector: 'futu/x', at: expect.any(Number), count: 2 },
    ]);
    // 磁盘上也只有归一化后的形态：消费侧（data.ts）拿到的一直是剥掉后缀的 selector。
    expect(await onDisk()).toEqual([{ selector: 'futu/x', at: expect.any(Number), count: 2 }]);
  });
});

describe('model history (legacy string[] migration)', () => {
  it('reads the old shape as `at: undefined, count: 1`', async () => {
    await writeFile(file(), JSON.stringify(['futu/a', 'futu/b']), 'utf8');
    expect(await recentModelEntries(5, file())).toEqual([
      { selector: 'futu/a', count: 1 },
      { selector: 'futu/b', count: 1 },
    ]);
  });

  it('upgrades the file on the first read, once (idempotent)', async () => {
    await writeFile(file(), JSON.stringify(['futu/a', 'futu/b']), 'utf8');
    await recentModelEntries(5, file());
    const upgraded = await readFile(file(), 'utf8');
    expect(JSON.parse(upgraded)).toEqual([
      { selector: 'futu/a', count: 1 },
      { selector: 'futu/b', count: 1 },
    ]);

    // 第二次读：结构已经是新的 → 不再写回（旧格式留下的时间戳不会被补造）。
    await recentModelEntries(5, file());
    expect(await readFile(file(), 'utf8')).toBe(upgraded);
  });

  it('reads an already-upgraded file as-is and leaves it untouched', async () => {
    const canonical = JSON.stringify([{ selector: 'futu/a', at: 12_345, count: 7 }]);
    await writeFile(file(), canonical, 'utf8');
    expect(await recentModelEntries(5, file())).toEqual([
      { selector: 'futu/a', at: 12_345, count: 7 },
    ]);
    expect(await readFile(file(), 'utf8')).toBe(canonical);
  });

  it('merges legacy selectors that only differ by a `:thinking` suffix', async () => {
    await writeFile(file(), JSON.stringify(['futu/x:thinking', 'futu/y', 'futu/x']), 'utf8');
    expect(await recentModelEntries(5, file())).toEqual([
      { selector: 'futu/x', count: 2 },
      { selector: 'futu/y', count: 1 },
    ]);
    expect(await onDisk()).toEqual([
      { selector: 'futu/x', count: 2 },
      { selector: 'futu/y', count: 1 },
    ]);
  });

  it('drops junk entries and trims a legacy file past the cap', async () => {
    const legacy = [...Array.from({ length: 25 }, (_, i) => `futu/m${i}`), 42, null, { nope: 1 }];
    await writeFile(file(), JSON.stringify(legacy), 'utf8');
    const entries = await recentModelEntries(100, file());
    expect(entries).toHaveLength(MAX_HISTORY_ENTRIES);
    expect(entries[0]).toEqual({ selector: 'futu/m0', count: 1 });
    expect(await onDisk()).toHaveLength(MAX_HISTORY_ENTRIES);
  });

  it('migrates on the next write even without a read', async () => {
    await writeFile(file(), JSON.stringify(['futu/a']), 'utf8');
    await recordModelUse('futu/b', file());
    expect(await onDisk()).toEqual([
      { selector: 'futu/b', at: expect.any(Number), count: 1 },
      { selector: 'futu/a', count: 1 }, // 旧条目保留，只是没有时间戳
    ]);
  });
});
