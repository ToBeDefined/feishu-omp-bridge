import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { WorkspaceStore } from './store';

let dir: string;
let file: string;
let stores: WorkspaceStore[];

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'ws-test-'));
  file = join(dir, 'workspaces.json');
  stores = [];
});
afterEach(async () => {
  await Promise.all(stores.map((s) => s.flush()));
  await rm(dir, { recursive: true, force: true });
});

describe('WorkspaceStore', () => {
  it('records and reads cwd per scope', async () => {
    const store = new WorkspaceStore(file);
    stores.push(store);
    expect(store.cwdFor('oc_1')).toBeUndefined();
    store.setCwd('oc_1', '/repo');
    expect(store.cwdFor('oc_1')).toBe('/repo');
  });

  it('persists across reload', async () => {
    const s1 = new WorkspaceStore(file);
    stores.push(s1);
    s1.setCwd('oc_1', '/repo');
    await s1.flush();
    const s2 = new WorkspaceStore(file);
    stores.push(s2);
    await s2.load();
    expect(s2.cwdFor('oc_1')).toBe('/repo');
  });

  it('starts empty on corrupt file', async () => {
    await writeFile(file, 'not json{{');
    const store = new WorkspaceStore(file);
    await store.load();
    expect(store.cwdFor('oc_1')).toBeUndefined();
  });

  it('persists atomically (no tmp residue)', async () => {
    const store = new WorkspaceStore(file);
    stores.push(store);
    store.setCwd('oc_1', '/repo');
    await store.flush();
    expect(await readdir(dir)).toEqual(['workspaces.json']);
  });
});
