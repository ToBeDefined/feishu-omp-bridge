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

describe('SessionStore clearSessionId', () => {
  it('drops the session but keeps the title and idle override', async () => {
    const store = new SessionStore(file);
    stores.push(store);
    store.set('oc_1', 'sess-1', '/repo');
    store.setTitle('oc_1', '修 search bug');
    store.setIdleTimeoutMinutes('oc_1', 30);

    store.clearSessionId('oc_1');

    // A stale-session rollover is not a context reset: /new /cd /ws own that.
    expect(store.getRaw('oc_1')?.sessionId).toBeUndefined();
    expect(store.getRaw('oc_1')?.cwd).toBeUndefined();
    expect(store.getIdleTimeoutMinutes('oc_1')).toBe(30);
    // The name belongs to the session, so it outlives the chat's binding.
    expect(store.titleFor('sess-1')).toBe('修 search bug');
    expect(store.resumeFor('oc_1', '/repo')).toBeUndefined();
    await store.flush();
  });

  it('keeps a bare override entry created before the first run', async () => {
    const store = new SessionStore(file);
    stores.push(store);
    store.setIdleTimeoutMinutes('oc_1', 15);

    store.clearSessionId('oc_1');

    expect(store.getIdleTimeoutMinutes('oc_1')).toBe(15);
    await store.flush();
  });
});

describe('SessionStore title', () => {
  it('sets and clears the current session title', async () => {
    const store = new SessionStore(file);
    stores.push(store);
    store.set('oc_1', 'sess-1', '/repo');

    expect(store.setTitle('oc_1', '修 search bug')).toBe(true);
    expect(store.titleFor('sess-1')).toBe('修 search bug');

    expect(store.clearTitle('oc_1')).toBe(true);
    expect(store.titleFor('sess-1')).toBeUndefined();

    // Clearing again reports nothing to remove.
    expect(store.clearTitle('oc_1')).toBe(false);
    await store.flush();
  });

  it('refuses to name a scope that has no session yet', async () => {
    const store = new SessionStore(file);
    stores.push(store);
    store.setIdleTimeoutMinutes('oc_1', 15);

    expect(store.setTitle('oc_1', '无会话可命名')).toBe(false);
    expect(store.titlesBySessionId()).toEqual({});
    await store.flush();
  });

  it('persists titles across load', async () => {
    const store = new SessionStore(file);
    stores.push(store);
    store.set('oc_1', 'sess-1', '/repo');
    store.setTitle('oc_1', '已命名会话');
    await store.flush();

    const reloaded = new SessionStore(file);
    await reloaded.load();
    expect(reloaded.titleFor('sess-1')).toBe('已命名会话');
  });

  it('keeps a title with ITS session when the chat moves to another one', async () => {
    const store = new SessionStore(file);
    stores.push(store);
    store.set('oc_1', 'sess-old', '/repo');
    store.setTitle('oc_1', '旧会话名');

    // /resume or /history 继续对话 re-points the chat at a historical session:
    // that session must not inherit the name of the one it replaced.
    store.set('oc_1', 'sess-new', '/repo');
    expect(store.titleFor('sess-new')).toBeUndefined();

    // ...and coming back must still show the name the user typed.
    store.set('oc_1', 'sess-old', '/repo');
    expect(store.titleFor('sess-old')).toBe('旧会话名');
    await store.flush();
  });

  it('keeps a session title across /new (the session still exists)', async () => {
    const store = new SessionStore(file);
    stores.push(store);
    store.set('oc_1', 'sess-1', '/repo');
    store.setTitle('oc_1', '保留的标题');

    store.clear('oc_1');
    expect(store.getRaw('oc_1')).toBeUndefined();
    expect(store.titleFor('sess-1')).toBe('保留的标题');

    // A fresh session in the same chat starts nameless.
    store.set('oc_1', 'sess-2', '/repo');
    expect(store.titleFor('sess-2')).toBeUndefined();
    await store.flush();
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

  it('migrates a title kept on the entry by an older file', async () => {
    await writeFileAtomic(file, JSON.stringify({
      oc_1: { sessionId: 'sess-1', cwd: '/repo', updatedAt: 123, title: '旧版标题' },
    }));
    const store = new SessionStore(file);
    stores.push(store);
    await store.load();

    // The pre-map file stored the name on the chat entry; it must survive the
    // upgrade attached to the session it was written for.
    expect(store.titleFor('sess-1')).toBe('旧版标题');
    expect(store.getRaw('oc_1')).toMatchObject({ sessionId: 'sess-1', cwd: '/repo' });
  });

  it('reads the titles map without mistaking it for a chat entry', async () => {
    await writeFileAtomic(file, JSON.stringify({
      titles: { 'sess-1': '地图里的标题' },
      oc_1: { sessionId: 'sess-1', cwd: '/repo', updatedAt: 123 },
    }));
    const store = new SessionStore(file);
    stores.push(store);
    await store.load();

    expect(store.titlesBySessionId()).toEqual({ 'sess-1': '地图里的标题' });
    expect(store.chats()).toEqual(['oc_1']);
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
    expect(store.titlesBySessionId()).toEqual({});
  });
});

describe('SessionStore set timestamps', () => {
  it('keeps the start time of the SAME session across re-runs', async () => {
    const store = new SessionStore(file);
    stores.push(store);
    store.set('oc_1', 'sess-1', '/repo');
    const first = store.getRaw('oc_1')?.createdAt;
    expect(first).toBeTypeOf('number');

    await new Promise((r) => setTimeout(r, 5));
    store.set('oc_1', 'sess-1', '/repo');
    expect(store.getRaw('oc_1')?.createdAt).toBe(first);
  });

  it("adopts a resumed session's own start/last-active times", async () => {
    const store = new SessionStore(file);
    stores.push(store);
    store.set('oc_1', 'sess-old', '/repo');

    store.set('oc_1', 'sess-new', '/repo', { createdAtMs: 1_000, updatedAtMs: 2_000 });

    // Inheriting the previous session's createdAt would report the wrong
    // conversation start for a session resumed from /history.
    expect(store.getRaw('oc_1')).toMatchObject({
      sessionId: 'sess-new',
      createdAt: 1_000,
      updatedAt: 2_000,
    });
  });

  it('stamps now for a session bound without times', async () => {
    const store = new SessionStore(file);
    stores.push(store);
    store.set('oc_1', 'sess-old', '/repo');
    const before = Date.now();

    store.set('oc_1', 'sess-fresh', '/repo');

    const entry = store.getRaw('oc_1');
    expect(entry?.createdAt).toBeGreaterThanOrEqual(before);
    expect(entry?.updatedAt).toBeGreaterThanOrEqual(before);
  });
});

async function writeFileAtomic(path: string, content: string): Promise<void> {
  await writeFile(path, content, 'utf8');
}

describe('SessionStore corruption tolerance', () => {
  it('starts empty when the file is corrupt', async () => {
    await writeFile(file, '{ not valid json');
    const store = new SessionStore(file);
    await store.load();
    expect(store.chats()).toEqual([]);
  });

  it('loads valid entries and skips malformed ones', async () => {
    await writeFile(
      file,
      JSON.stringify({
        oc_good: { sessionId: 's1', cwd: '/repo', updatedAt: 1 },
        oc_bad: { sessionId: 's2', cwd: '/repo' }, // 缺 updatedAt
        oc_empty: {},
      }),
    );
    const store = new SessionStore(file);
    await store.load();
    expect(store.chats().sort()).toEqual(['oc_good']);
    expect(store.resumeFor('oc_good', '/repo')).toBe('s1');
  });

  it('persists atomically (tmp file removed after save)', async () => {
    const store = new SessionStore(file);
    stores.push(store);
    store.set('oc_1', 's1', '/repo');
    await store.flush();
    const { readdir } = await import('node:fs/promises');
    const names = await readdir(dir);
    expect(names).toEqual(['sessions.json']); // 无 .tmp- 残留
  });
});
