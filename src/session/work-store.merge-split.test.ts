import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { WorkSessionStore } from './work-store';
import type { WorkSegment, WorkSession } from './work-session';

vi.mock('../core/logger', () => ({ log: { info: vi.fn(), warn: vi.fn(), fail: vi.fn() } }));

let dir: string;
let file: string;
let stores: WorkSessionStore[];

beforeEach(async () => {
  vi.clearAllMocks();
  dir = await mkdtemp(join(tmpdir(), 'work-store-ms-'));
  file = join(dir, 'sessions.json');
  stores = [];
});
afterEach(async () => {
  await Promise.all(stores.map((s) => s.flush()));
  await rm(dir, { recursive: true, force: true });
});

function track(store: WorkSessionStore): WorkSessionStore {
  stores.push(store);
  return store;
}

function seg(sessionId: string, cwd: string, startedAtMs: number, lastActiveAtMs = startedAtMs): WorkSegment {
  return { sessionId, cwd, startedAtMs, lastActiveAtMs };
}

/** Seed a v2 file and load it — the exact shapes `mergeWorkSessions` sees. */
async function seed(
  workSessions: Record<string, WorkSession>,
  scopes: Record<string, { activeWorkSession?: string }> = {},
): Promise<WorkSessionStore> {
  await writeFile(file, JSON.stringify({ v: 2, scopes, workSessions }), 'utf8');
  const store = track(new WorkSessionStore(file));
  await store.load();
  return store;
}

const ids = (ws: WorkSession | undefined): string[] => (ws?.segments ?? []).map((s) => s.sessionId);

describe('WorkSessionStore mergeWorkSessions', () => {
  const keep: WorkSession = {
    id: 's1',
    scope: 'oc_1',
    cwd: '/repo',
    createdAtMs: 1,
    lastActiveAtMs: 3,
    currentSegmentId: 's1',
    segments: [seg('s1', '/repo', 1), seg('shared', '/latest', 3)],
  };
  const fold: WorkSession = {
    id: 's2',
    scope: 'oc_1',
    title: '折叠名',
    cwd: '/other',
    createdAtMs: 2,
    lastActiveAtMs: 2,
    currentSegmentId: 's2',
    segments: [seg('s2', '/other', 2), seg('shared', '/latest', 3)],
  };

  it('merges segments in chronological order, de-duplicated, and deletes the fold', async () => {
    // oc_1 currently points at the fold — the pointer must follow it out.
    const store = await seed({ s1: keep, s2: fold }, { oc_1: { activeWorkSession: 's2' } });

    expect(store.mergeWorkSessions('s1', 's2')).toBe(true);

    expect(store.workSessionById('s2')).toBeUndefined();
    const merged = store.workSessionById('s1');
    // Chronological, and the shared segment appears exactly once.
    expect(ids(merged)).toEqual(['s1', 's2', 'shared']);
    expect(new Set(ids(merged)).size).toBe(3);
    // Scope pointer repointed at the survivor.
    expect(store.activeWorkSession('oc_1')?.id).toBe('s1');
  });

  it("prefers keep's title, else takes fold's; scope/cwd/activity follow the latest segment", async () => {
    const store = await seed({ s1: keep, s2: { ...fold, scope: null } });

    expect(store.mergeWorkSessions('s1', 's2')).toBe(true);
    const merged = store.workSessionById('s1');
    // keep has no title → fold's is adopted; keep's scope (oc_1) wins over null.
    expect(merged?.title).toBe('折叠名');
    expect(merged?.scope).toBe('oc_1');
    // Latest activity is `shared` (t=3, /latest).
    expect(merged?.cwd).toBe('/latest');
    expect(merged?.lastActiveAtMs).toBe(3);
    // Later-active current wins: fold's s2 (2) over keep's s1 (1).
    expect(merged?.currentSegmentId).toBe('s2');
  });

  it('keeps the keep title when both work sessions are named', async () => {
    const store = await seed({
      s1: { ...keep, title: '保留的名字' },
      s2: fold,
    });

    store.mergeWorkSessions('s1', 's2');
    expect(store.workSessionById('s1')?.title).toBe('保留的名字');
  });

  it('returns false for an unknown id or a self-merge and changes nothing', async () => {
    const store = await seed({ s1: keep });

    expect(store.mergeWorkSessions('s1', 'nope')).toBe(false);
    expect(store.mergeWorkSessions('nope', 's1')).toBe(false);
    expect(store.mergeWorkSessions('s1', 's1')).toBe(false);
    expect(store.workSessionById('s1')?.segments).toHaveLength(2);
  });

  it('re-ids the survivor to the earliest segment, so a later split cannot collide (regression)', async () => {
    // The card's default direction is keep = the NEWER row, fold = the older
    // one: after the chronological sort the first segment is the folded (older)
    // session, while the key stayed on the newer id. Before the fix, splitting
    // at that newer segment (fromSegmentId === wsId) overwrote the new work
    // session with the head and silently dropped the whole tail.
    const older: WorkSession = {
      id: 's-old',
      scope: 'oc_1',
      cwd: '/a',
      createdAtMs: 1,
      lastActiveAtMs: 1,
      currentSegmentId: 's-old',
      segments: [seg('s-old', '/a', 1)],
    };
    const newer: WorkSession = {
      id: 's-new',
      scope: 'oc_1',
      cwd: '/b',
      createdAtMs: 5,
      lastActiveAtMs: 6,
      currentSegmentId: 's-new2',
      segments: [seg('s-new', '/b', 5), seg('s-new2', '/b', 6)],
    };
    const store = await seed(
      { 's-old': older, 's-new': newer },
      { oc_1: { activeWorkSession: 's-new' } },
    );

    expect(store.mergeWorkSessions('s-new', 's-old')).toBe(true);
    // Invariant restored: id === segments[0].sessionId, no dangling old key.
    expect(store.workSessionById('s-new')).toBeUndefined();
    const merged = store.workSessionById('s-old');
    expect(merged?.id).toBe('s-old');
    expect(ids(merged)).toEqual(['s-old', 's-new', 's-new2']);
    // Scope pointer followed the re-key.
    expect(store.activeWorkSession('oc_1')?.id).toBe('s-old');

    // Split at the segment whose id USED to be the key — the exact collision.
    expect(store.splitWorkSession('s-old', 's-new')).toBe('s-new');
    const head = store.workSessionById('s-old');
    const tail = store.workSessionById('s-new');
    expect(head?.id).not.toBe(tail?.id);
    expect(ids(head)).toEqual(['s-old']);
    expect(ids(tail)).toEqual(['s-new', 's-new2']);
    // Nothing lost or duplicated across the two.
    expect([...ids(head), ...ids(tail)].sort()).toEqual(['s-new', 's-new2', 's-old']);
  });

  it('treats a whitespace-only title as absent', async () => {
    // A blank keep title must not block the fold's real name...
    const named = await seed({ s1: { ...keep, title: '   ' }, s2: fold });
    named.mergeWorkSessions('s1', 's2');
    expect(named.workSessionById('s1')?.title).toBe('折叠名');

    // ...and when neither side has a real name, the blank one is cleared.
    const blanks = await seed({ s1: { ...keep, title: '  ' }, s2: { ...fold, title: '\t' } });
    blanks.mergeWorkSessions('s1', 's2');
    expect(blanks.workSessionById('s1')?.title).toBeUndefined();
  });
});

describe('WorkSessionStore splitWorkSession', () => {
  /** A 3-segment work session: segments s1/s2/s3 chained on one work session. */
  async function threeSegments(): Promise<WorkSessionStore> {
    const store = track(new WorkSessionStore(file));
    await store.load();
    store.bindSegment('oc_1', 's1', '/repo', { startedAtMs: 1, lastActiveAtMs: 1 });
    store.dropCurrentSegment('oc_1');
    store.bindSegment('oc_1', 's2', '/other', { startedAtMs: 2, lastActiveAtMs: 2 });
    store.dropCurrentSegment('oc_1');
    store.bindSegment('oc_1', 's3', '/repo', { startedAtMs: 3, lastActiveAtMs: 3 });
    return store;
  }

  it('cuts every segment from the split point into a new work session, losing none', async () => {
    const store = await threeSegments();

    expect(store.splitWorkSession('s1', 's2')).toBe('s2');

    const head = store.workSessionById('s1');
    const tail = store.workSessionById('s2');
    expect(ids(head)).toEqual(['s1']);
    expect(ids(tail)).toEqual(['s2', 's3']);
    // Nothing lost or duplicated across the two.
    expect([...ids(head), ...ids(tail)].sort()).toEqual(['s1', 's2', 's3']);
    // Original's derived fields describe what is left.
    expect(head?.lastActiveAtMs).toBe(1);
    expect(head?.cwd).toBe('/repo');
    // New work session: id = cut segment, scope carried over, fields from tail.
    expect(tail?.scope).toBe('oc_1');
    expect(tail?.createdAtMs).toBe(2);
    expect(tail?.lastActiveAtMs).toBe(3);
    expect(tail?.cwd).toBe('/repo');
  });

  it('moves the current segment to the tail and clears it on the head', async () => {
    const store = await threeSegments(); // current = s3, lives in the tail

    store.splitWorkSession('s1', 's2');

    expect(store.workSessionById('s1')?.currentSegmentId).toBeUndefined();
    expect(store.workSessionById('s2')?.currentSegmentId).toBe('s3');
  });

  it('keeps the current segment on the head when it did not move', async () => {
    const store = await threeSegments();
    store.adoptWorkSession('oc_1', 's1', undefined, 's2'); // current = s2 (head side)

    store.splitWorkSession('s1', 's3');

    expect(store.workSessionById('s1')?.currentSegmentId).toBe('s2');
    expect(store.workSessionById('s3')?.currentSegmentId).toBeUndefined();
  });

  it('returns undefined for an unknown id, an unknown segment, or the first segment', async () => {
    const store = await threeSegments();

    expect(store.splitWorkSession('nope', 's2')).toBeUndefined();
    expect(store.splitWorkSession('s1', 'nope')).toBeUndefined();
    expect(store.splitWorkSession('s1', 's1')).toBeUndefined(); // first segment
    // Nothing changed while rejecting.
    expect(ids(store.workSessionById('s1'))).toEqual(['s1', 's2', 's3']);
  });

  it('repairs a dirty work session whose key is not its first segment before cutting', async () => {
    // importSnapshot seeds exactly the hand-edited / legacy shape: the key
    // drifted from segments[0].sessionId. Splitting must still lose nothing.
    const store = track(new WorkSessionStore(file));
    await store.load();
    store.importSnapshot({
      v: 2,
      scopes: { oc_1: { activeWorkSession: 'wrong-key' } },
      workSessions: {
        'wrong-key': {
          id: 'wrong-key',
          scope: 'oc_1',
          cwd: '/repo',
          createdAtMs: 1,
          lastActiveAtMs: 3,
          currentSegmentId: 's3',
          segments: [seg('s1', '/repo', 1), seg('s2', '/repo', 2), seg('s3', '/repo', 3)],
        },
      },
    });

    expect(store.splitWorkSession('wrong-key', 's2')).toBe('s2');
    expect(store.workSessionById('wrong-key')).toBeUndefined();
    const head = store.workSessionById('s1');
    const tail = store.workSessionById('s2');
    expect(ids(head)).toEqual(['s1']);
    expect(ids(tail)).toEqual(['s2', 's3']);
    expect([...ids(head), ...ids(tail)].sort()).toEqual(['s1', 's2', 's3']);
    // Scope pointer was re-pointed to the repaired key.
    expect(store.activeWorkSession('oc_1')?.id).toBe('s1');
  });
});
