import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { recordModelUse, recentModels } from './model-history';

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'model-history-test-'));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

function file(): string {
  return join(dir, 'history.json');
}

describe('model history (dedup, order, cap)', () => {
  it('records models newest-first, deduped', async () => {
    await recordModelUse('futu/a', file());
    await recordModelUse('futu/b', file());
    await recordModelUse('futu/a', file()); // duplicate — moves back to front
    expect(await recentModels(5, file())).toEqual(['futu/a', 'futu/b']);
  });

  it('recentModels returns at most `limit` entries', async () => {
    for (const m of ['futu/a', 'futu/b', 'futu/c', 'futu/d', 'futu/e', 'futu/f']) {
      await recordModelUse(m, file());
    }
    expect(await recentModels(3, file())).toEqual(['futu/f', 'futu/e', 'futu/d']);
    expect(await recentModels(10, file())).toHaveLength(6);
  });

  it('caps history at MAX_ENTRIES (20)', async () => {
    for (let i = 0; i < 25; i++) {
      await recordModelUse(`futu/m${i}`, file());
    }
    const all = await recentModels(100, file());
    expect(all).toHaveLength(20);
    expect(all[0]).toBe('futu/m24'); // newest first
  });

  it('ignores empty model names', async () => {
    await recordModelUse('', file());
    await recordModelUse('   ', file());
    expect(await recentModels(5, file())).toEqual([]);
  });

  it('survives a corrupt file (returns empty, then recovers)', async () => {
    await import('node:fs/promises').then((fs) => fs.writeFile(file(), '{not json', 'utf8'));
    expect(await recentModels(5, file())).toEqual([]);
    await recordModelUse('futu/a', file());
    expect(await recentModels(5, file())).toEqual(['futu/a']);
  });

  it('persists across reads (same underlying file)', async () => {
    await recordModelUse('futu/a', file());
    const text = await readFile(file(), 'utf8');
    expect(JSON.parse(text)).toEqual(['futu/a']);
  });
});
