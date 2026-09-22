import { mkdtempSync, readFileSync, rmSync, writeFileSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { paths } from '../../config/paths';
import { commonOmpModels, loadModelData } from './data';
import type { ModelsCache } from './data';

let dir: string;
let cacheFile: string;
let fakeOmp: string;
// Fake omp reads this file to decide which model list to serve, letting the
// test flip the "remote" list between two loads.
let serveFile: string;
// Served for `omp config get modelRoles --json`.
let rolesFile: string;

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'model-data-test-'));
  cacheFile = join(dir, 'models-cache.json');
  serveFile = join(dir, 'serve.json');
  rolesFile = join(dir, 'roles.json');
  fakeOmp = join(dir, 'fake-omp.sh');
  writeFileSync(fakeOmp, [
    '#!/bin/bash',
    'if [[ "$1" == "models" ]]; then cat "$(dirname "$0")/serve.json"; exit 0; fi',
    'if [[ "$1" == "config" ]]; then cat "$(dirname "$0")/roles.json"; exit 0; fi',
    'exit 1',
  ].join('\n'));
  chmodSync(fakeOmp, 0o755);
  writeFileSync(rolesFile, JSON.stringify({ value: {} }));
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

describe('commonOmpModels', () => {
  it('offers chat roles and drops the non-chat kind roles', async () => {
    const cfg = { preferences: { ompBinary: fakeOmp } } as never;
    writeFileSync(
      rolesFile,
      JSON.stringify({
        value: {
          default: 'p1/chat:high',
          smol: 'p1/chat:low',
          vision: 'p1/vision',
          memory: 'p1/memory',
          image: 'p1/gpt-image-1',
          web: 'p1/gemini-search',
          speech: 'p1/tts-1',
          dictation: 'p1/whisper-1',
          judge: 'p1/judge-1',
          bare: 'no-provider',
        },
      }),
    );
    // Only chat-capable roles reach the quick-set buttons: pointing `omp
    // --model` at a TTS/search/image model fails every run in that chat.
    expect(await commonOmpModels(cfg)).toEqual(['p1/chat', 'p1/vision', 'p1/memory']);
  });
});
