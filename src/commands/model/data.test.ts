import { mkdtempSync, readFileSync, rmSync, writeFileSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { paths } from '../../config/paths';
import { loadModelData } from './data';
import type { ModelsCache } from './data';

let dir: string;
let cacheFile: string;
let fakeOmp: string;
// Fake omp reads this file to decide which model list to serve, letting the
// test flip the "remote" list between two loads.
let serveFile: string;

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'model-data-test-'));
  cacheFile = join(dir, 'models-cache.json');
  serveFile = join(dir, 'serve.json');
  fakeOmp = join(dir, 'fake-omp.sh');
  writeFileSync(fakeOmp, [
    '#!/bin/bash',
    'if [[ "$1" == "models" ]]; then cat "$(dirname "$0")/serve.json"; exit 0; fi',
    'if [[ "$1" == "config" ]]; then echo \'{"value":{}}\'; exit 0; fi',
    'exit 1',
  ].join('\n'));
  chmodSync(fakeOmp, 0o755);
  vi.spyOn(paths, 'modelsCacheFile', 'get').mockReturnValue(cacheFile);
});

afterAll(() => {
  vi.restoreAllMocks();
  rmSync(dir, { recursive: true, force: true });
});

describe('loadModelData', () => {
  it('force refresh rewrites the disk cache (regression: refresh left stale cache)', async () => {
    // Built here, not at module scope: fakeOmp is only assigned in beforeAll.
    const cfg = { preferences: { ompBinary: fakeOmp } } as never;

    // v1 list served → force refresh → must persist v1 to disk.
    writeFileSync(serveFile, JSON.stringify({ models: [{ provider: 'p1', selector: 'p1/v1' }] }));
    const first = await loadModelData(cfg, true);
    expect(first.list).toHaveLength(1);
    const onDisk = JSON.parse(readFileSync(cacheFile, 'utf8')) as ModelsCache;
    expect(onDisk.list[0]!.selector).toBe('p1/v1');

    // Remote now serves v2; force refresh must persist it so a later
    // non-force load (within TTL) sees v2, not the stale v1.
    writeFileSync(serveFile, JSON.stringify({ models: [{ provider: 'p1', selector: 'p1/v2' }] }));
    await loadModelData(cfg, true);
    const cached = await loadModelData(cfg, false);
    expect(cached.list[0]!.selector).toBe('p1/v2');
  });
});
