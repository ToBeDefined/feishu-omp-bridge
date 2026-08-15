import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SessionStore } from './store';

let dir: string;
let file: string;
let stores: SessionStore[];

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'store-test-'));
  file = join(dir, 'sessions.json');
  stores = [];
});
afterEach(async () => {
  // Let every store's chained persist write settle before removing the dir,
  // otherwise a pending write races the rmdir and surfaces as ENOTEMPTY.
  await Promise.all(stores.map((s) => s.flush()));
  await rm(dir, { recursive: true, force: true });
});

describe('SessionStore title', () => {
  it('sets and clears a title', async () => {
    const store = new SessionStore(file);
    stores.push(store);
    store.set('oc_1', 'sess-1', '/repo');

    store.setTitle('oc_1', '修 search bug');
    expect(store.getRaw('oc_1')?.title).toBe('修 search bug');

    expect(store.clearTitle('oc_1')).toBe(true);
    expect(store.getRaw('oc_1')?.title).toBeUndefined();

    // Clearing again reports nothing to remove.
    expect(store.clearTitle('oc_1')).toBe(false);
    await store.flush();
  });

  it('persists title across load', async () => {
    const store = new SessionStore(file);
    stores.push(store);
    store.set('oc_1', 'sess-1', '/repo');
    store.setTitle('oc_1', '已命名会话');
    await store.flush();

    const reloaded = new SessionStore(file);
    await reloaded.load();
    expect(reloaded.getRaw('oc_1')?.title).toBe('已命名会话');
  });

  it('keeps title across session rollover in set', async () => {
    const store = new SessionStore(file);
    stores.push(store);
    store.set('oc_1', 'sess-old', '/repo');
    store.setTitle('oc_1', '持续标题');

    // New session id in the same chat must keep the title.
    store.set('oc_1', 'sess-new', '/repo');
    expect(store.getRaw('oc_1')?.sessionId).toBe('sess-new');
    expect(store.getRaw('oc_1')?.title).toBe('持续标题');
  });

  it('wipes title on clear', async () => {
    const store = new SessionStore(file);
    stores.push(store);
    store.set('oc_1', 'sess-1', '/repo');
    store.setTitle('oc_1', '将清空');
    store.clear('oc_1');
    expect(store.getRaw('oc_1')).toBeUndefined();
  });

  it('maps session ids to titles', async () => {
    const store = new SessionStore(file);
    stores.push(store);
    store.set('oc_1', 'sess-a', '/a');
    store.setTitle('oc_1', 'A 会话');
    store.set('oc_2', 'sess-b', '/b');
    store.set('oc_3', 'sess-c', '/c'); // no title

    expect(store.titlesBySessionId()).toEqual({ 'sess-a': 'A 会话' });
  });

  it('ignores a title on an entry with no session id when loading', async () => {
    // A bare entry with only a title and updatedAt should not resurrect a
    // session key with a title but no resumable session.
    await writeFileAtomic(file, JSON.stringify({
      oc_1: { title: '孤儿标题', updatedAt: 123 },
    }));
    const store = new SessionStore(file);
    stores.push(store);
    await store.load();
    expect(store.getRaw('oc_1')).toBeUndefined();
  });
});

async function writeFileAtomic(path: string, content: string): Promise<void> {
  await writeFile(path, content, 'utf8');
}
