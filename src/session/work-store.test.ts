import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { WorkSessionStore } from './work-store';

let dir: string;
let file: string;
let stores: WorkSessionStore[];

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'work-store-test-'));
  file = join(dir, 'sessions.json');
  stores = [];
});
afterEach(async () => {
  // Let every store's chained persist write settle before removing the dir,
  // otherwise a pending write races the rmdir and surfaces as ENOTEMPTY.
  await Promise.all(stores.map((s) => s.flush()));
  await rm(dir, { recursive: true, force: true });
});

describe('WorkSessionStore dropCurrentSegment', () => {
  it('drops the current segment but keeps the work session, its title and idle override', async () => {
    const store = new WorkSessionStore(file);
    stores.push(store);
    store.bindSegment('oc_1', 'sess-1', '/repo');
    store.setTitle('oc_1', '修 search bug');
    store.setIdleTimeoutMinutes('oc_1', 30);

    store.dropCurrentSegment('oc_1');

    // A stale-session rollover is not a context reset: /new /cd /ws own that.
    // The segment itself stays in the work session (visible in /history), only
    // the "current" pointer is cleared.
    const ws = store.activeWorkSession('oc_1');
    expect(ws?.currentSegmentId).toBeUndefined();
    expect(ws?.segments.map((s) => s.sessionId)).toEqual(['sess-1']);
    expect(store.getIdleTimeoutMinutes('oc_1')).toBe(30);
    // The name belongs to the work session, so it outlives the chat's binding.
    expect(store.titleFor('sess-1')).toBe('修 search bug');
    expect(store.resumeFor('oc_1', '/repo')).toBeUndefined();
    await store.flush();
  });

  it('keeps a bare override entry created before the first run', async () => {
    const store = new WorkSessionStore(file);
    stores.push(store);
    store.setIdleTimeoutMinutes('oc_1', 15);

    store.dropCurrentSegment('oc_1');

    expect(store.getIdleTimeoutMinutes('oc_1')).toBe(15);
    await store.flush();
  });
});

describe('WorkSessionStore title', () => {
  it('sets and clears the current work session title', async () => {
    const store = new WorkSessionStore(file);
    stores.push(store);
    store.bindSegment('oc_1', 'sess-1', '/repo');

    expect(store.setTitle('oc_1', '修 search bug')).toBe(true);
    expect(store.titleFor('sess-1')).toBe('修 search bug');

    expect(store.clearTitle('oc_1')).toBe(true);
    expect(store.titleFor('sess-1')).toBeUndefined();

    // Clearing again reports nothing to remove.
    expect(store.clearTitle('oc_1')).toBe(false);
    await store.flush();
  });

  it('refuses to name a scope that has no work session yet', async () => {
    const store = new WorkSessionStore(file);
    stores.push(store);
    store.setIdleTimeoutMinutes('oc_1', 15);

    expect(store.setTitle('oc_1', '无工作会话可命名')).toBe(false);
    expect(store.allWorkSessions()).toEqual([]);
    await store.flush();
  });

  it('persists titles across load', async () => {
    const store = new WorkSessionStore(file);
    stores.push(store);
    store.bindSegment('oc_1', 'sess-1', '/repo');
    store.setTitle('oc_1', '已命名工作会话');
    await store.flush();

    const reloaded = new WorkSessionStore(file);
    await reloaded.load();
    expect(reloaded.titleFor('sess-1')).toBe('已命名工作会话');
  });

  it('keeps a title with ITS work session when a new one starts', async () => {
    const store = new WorkSessionStore(file);
    stores.push(store);
    store.bindSegment('oc_1', 'sess-old', '/repo');
    store.setTitle('oc_1', '旧工作名');

    // /work archives the current work session: the next one must not inherit
    // the name of the work it replaced.
    store.startWorkSession('oc_1');
    store.bindSegment('oc_1', 'sess-new', '/repo');
    expect(store.titleFor('sess-new')).toBeUndefined();

    // ...and the archived work keeps the name the user typed.
    expect(store.titleFor('sess-old')).toBe('旧工作名');
    await store.flush();
  });

  it('keeps a work-session title across /new (the work still exists)', async () => {
    const store = new WorkSessionStore(file);
    stores.push(store);
    store.bindSegment('oc_1', 'sess-1', '/repo');
    store.setTitle('oc_1', '保留的标题');

    // /new appends the next run as a fresh segment of the SAME work session.
    store.dropCurrentSegment('oc_1');
    expect(store.titleFor('sess-1')).toBe('保留的标题');
    await store.flush();
  });

  it('maps every segment of a work session to its title', async () => {
    const store = new WorkSessionStore(file);
    stores.push(store);
    store.bindSegment('oc_1', 'sess-a', '/a');
    store.setTitle('oc_1', 'A 工作');
    store.bindSegment('oc_2', 'sess-b', '/b');
    store.bindSegment('oc_3', 'sess-c', '/c'); // no title

    expect(store.titleFor('sess-a')).toBe('A 工作');
    expect(store.titleFor('sess-b')).toBeUndefined();
    expect(store.titleFor('sess-c')).toBeUndefined();
  });

  it('migrates a title kept on the entry by an older file', async () => {
    await writeFileAtomic(file, JSON.stringify({
      oc_1: { sessionId: 'sess-1', cwd: '/repo', updatedAt: 123, title: '旧版标题' },
    }));
    const store = new WorkSessionStore(file);
    stores.push(store);
    await store.load();

    // The pre-map file stored the name on the chat entry; it must survive the
    // upgrade attached to the work session it was written for.
    expect(store.titleFor('sess-1')).toBe('旧版标题');
    expect(store.activeWorkSession('oc_1')).toMatchObject({ id: 'sess-1', cwd: '/repo' });
  });

  it('reads the flat titles map without mistaking it for a chat entry', async () => {
    await writeFileAtomic(file, JSON.stringify({
      titles: { 'sess-1': '地图里的标题' },
      oc_1: { sessionId: 'sess-1', cwd: '/repo', updatedAt: 123 },
    }));
    const store = new WorkSessionStore(file);
    stores.push(store);
    await store.load();

    expect(store.titleFor('sess-1')).toBe('地图里的标题');
    expect(store.chats()).toEqual(['oc_1']);
  });

  it('ignores a title on an entry with no session id when loading', async () => {
    // A bare entry with only a title and updatedAt should not resurrect a
    // work session with a title but no resumable segment.
    await writeFileAtomic(file, JSON.stringify({
      oc_1: { title: '孤儿标题', updatedAt: 123 },
    }));
    const store = new WorkSessionStore(file);
    stores.push(store);
    await store.load();
    expect(store.activeWorkSession('oc_1')).toBeUndefined();
    expect(store.allWorkSessions()).toEqual([]);
  });
});

describe('WorkSessionStore segment timestamps', () => {
  it('keeps the start time of the SAME segment across re-runs', async () => {
    const store = new WorkSessionStore(file);
    stores.push(store);
    store.bindSegment('oc_1', 'sess-1', '/repo');
    const first = store.activeWorkSession('oc_1')?.segments[0]?.startedAtMs;
    expect(first).toBeTypeOf('number');

    store.bindSegment('oc_1', 'sess-1', '/repo');
    expect(store.activeWorkSession('oc_1')?.segments[0]?.startedAtMs).toBe(first);
  });

  it('advances a re-run of the same segment to this run time', async () => {
    const store = new WorkSessionStore(file);
    stores.push(store);
    store.bindSegment('oc_1', 'sess-1', '/repo', { startedAtMs: 1, lastActiveAtMs: 1 });
    const now = Date.now();

    store.bindSegment('oc_1', 'sess-1', '/repo', { lastActiveAtMs: now });

    const ws = store.activeWorkSession('oc_1');
    expect(ws?.segments).toHaveLength(1);
    expect(ws?.segments[0]?.startedAtMs).toBe(1);
    expect(ws?.segments[0]?.lastActiveAtMs).toBe(now);
    expect(ws?.lastActiveAtMs).toBe(now);
  });

  it("adopts a resumed session's own start/last-active times without pulling the work session back", async () => {
    const store = new WorkSessionStore(file);
    stores.push(store);
    store.bindSegment('oc_1', 'sess-old', '/repo');
    const activeBefore = store.activeWorkSession('oc_1')?.lastActiveAtMs ?? 0;

    store.bindSegment('oc_1', 'sess-new', '/repo', { startedAtMs: 1_000, lastActiveAtMs: 2_000 });

    // Inheriting the previous segment's start would report the wrong session
    // start for a segment resumed from /history.
    expect(store.activeWorkSession('oc_1')?.segments.at(-1)).toMatchObject({
      sessionId: 'sess-new',
      startedAtMs: 1_000,
      lastActiveAtMs: 2_000,
    });
    // 1_000/2_000 是过去的时刻：历史会话的活跃时间不能把工作会话拽回去。
    expect(store.activeWorkSession('oc_1')?.lastActiveAtMs).toBeGreaterThanOrEqual(activeBefore);
  });

  it('never lowers the work session lastActiveAtMs when binding a historical session', async () => {
    const store = new WorkSessionStore(file);
    stores.push(store);
    store.bindSegment('oc_1', 'sess-now', '/repo');   // at = now（真实当前时间）
    const before = store.activeWorkSession('oc_1')?.lastActiveAtMs ?? 0;
    expect(before).toBeGreaterThan(2_000);

    // /resume、/history 继续对话绑的是很久以前的会话。
    store.bindSegment('oc_1', 'sess-history', '/repo', { startedAtMs: 1_000, lastActiveAtMs: 2_000 });

    const ws = store.activeWorkSession('oc_1');
    expect(ws?.lastActiveAtMs).toBe(before);          // 不回退
    expect(ws?.segments.at(-1)).toMatchObject({
      sessionId: 'sess-history',
      startedAtMs: 1_000,
      lastActiveAtMs: 2_000,                          // 段保留它自己的历史时间
    });
  });

  it('stamps now for a segment bound without times', async () => {
    const store = new WorkSessionStore(file);
    stores.push(store);
    store.bindSegment('oc_1', 'sess-old', '/repo');
    const before = Date.now();

    store.bindSegment('oc_1', 'sess-fresh', '/repo');

    const seg = store.activeWorkSession('oc_1')?.segments.at(-1);
    expect(seg?.startedAtMs).toBeGreaterThanOrEqual(before);
    expect(seg?.lastActiveAtMs).toBeGreaterThanOrEqual(before);
  });
});

async function writeFileAtomic(path: string, content: string): Promise<void> {
  await writeFile(path, content, 'utf8');
}

describe('WorkSessionStore corruption tolerance', () => {
  it('starts empty when the file is corrupt', async () => {
    await writeFile(file, '{ not valid json');
    const store = new WorkSessionStore(file);
    stores.push(store);
    await store.load();
    expect(store.chats()).toEqual([]);
  });

  it('tolerates a file whose JSON content is the literal null', async () => {
    // `null` 是合法 JSON：JSON.parse 返回 null，旧实现直接读 raw.v 会抛 TypeError。
    await writeFile(file, 'null');
    const store = new WorkSessionStore(file);
    stores.push(store);
    await store.load();
    expect(store.chats()).toEqual([]);
    expect(store.allWorkSessions()).toEqual([]);
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
    const store = new WorkSessionStore(file);
    stores.push(store);
    await store.load();
    expect(store.chats().sort()).toEqual(['oc_good']);
    expect(store.resumeFor('oc_good', '/repo')).toBe('s1');
  });

  it('persists atomically (tmp file removed after save)', async () => {
    const store = new WorkSessionStore(file);
    stores.push(store);
    store.bindSegment('oc_1', 's1', '/repo');
    await store.flush();
    const names = await readdir(dir);
    expect(names).toEqual(['sessions.json']); // 无 .tmp- 残留
  });
});

describe('WorkSessionStore v2', () => {
  it('loads a v1 file as one work session with one segment', async () => {
    await writeFileAtomic(file, JSON.stringify({
      oc_1: { sessionId: 'sess-1', cwd: '/repo', updatedAt: 200, createdAt: 100, title: '旧文件里的名字' },
    }));
    const store = new WorkSessionStore(file);
    stores.push(store);
    await store.load();

    const ws = store.activeWorkSession('oc_1');
    expect(ws).toMatchObject({ id: 'sess-1', scope: 'oc_1', cwd: '/repo', createdAtMs: 100 });
    expect(ws?.segments).toEqual([
      { sessionId: 'sess-1', cwd: '/repo', startedAtMs: 100, lastActiveAtMs: 200 },
    ]);
    expect(ws?.title).toBe('旧文件里的名字');
    // 旧的平铺 titles 段也要读进来
    await store.flush();
    const onDisk = JSON.parse(await readFile(file, 'utf8')) as { v: number };
    expect(onDisk.v).toBe(2);
  });

  it('reads the legacy flat titles map when the entry has no title', async () => {
    await writeFileAtomic(file, JSON.stringify({
      titles: { 'sess-1': '地图里的名字' },
      oc_1: { sessionId: 'sess-1', cwd: '/repo', updatedAt: 200 },
    }));
    const store = new WorkSessionStore(file);
    stores.push(store);
    await store.load();

    expect(store.activeWorkSession('oc_1')?.title).toBe('地图里的名字');
  });

  it('keeps only the idle override when a v1 entry has no updatedAt', async () => {
    await writeFileAtomic(file, JSON.stringify({
      oc_1: { sessionId: 'sess-1', cwd: '/repo', idleTimeoutMinutes: 45 },
    }));
    const store = new WorkSessionStore(file);
    stores.push(store);
    await store.load();

    expect(store.getIdleTimeoutMinutes('oc_1')).toBe(45);
    expect(store.activeWorkSession('oc_1')).toBeUndefined();
    expect(store.allWorkSessions()).toEqual([]);
  });

  it('appends a segment when OMP rolls to a new session (no new work session)', async () => {
    const store = new WorkSessionStore(file);
    stores.push(store);
    await store.load();
    store.bindSegment('oc_1', 'sess-a', '/repo', { startedAtMs: 1, lastActiveAtMs: 1 });
    store.dropCurrentSegment('oc_1');            // stale 漂移 / /new：只丢当前段指针
    store.bindSegment('oc_1', 'sess-b', '/repo', { startedAtMs: 2, lastActiveAtMs: 2 });

    const ws = store.activeWorkSession('oc_1');
    expect(ws?.id).toBe('sess-a');
    expect(ws?.segments.map((s) => s.sessionId)).toEqual(['sess-a', 'sess-b']);
    expect(ws?.currentSegmentId).toBe('sess-b');
  });

  it('resumes only the current segment in the requested cwd', async () => {
    const store = new WorkSessionStore(file);
    stores.push(store);
    await store.load();
    store.bindSegment('oc_1', 'sess-a', '/repo');
    expect(store.resumeFor('oc_1', '/repo')).toBe('sess-a');
    expect(store.resumeFor('oc_1', '/other')).toBeUndefined();   // cwd 变了 → 起新段
    store.dropCurrentSegment('oc_1');
    expect(store.resumeFor('oc_1', '/repo')).toBeUndefined();    // /new 之后不复用旧段
  });

  it('names the active work session, not the chat or the OMP session', async () => {
    const store = new WorkSessionStore(file);
    stores.push(store);
    await store.load();
    store.bindSegment('oc_1', 'sess-a', '/repo');
    store.setTitle('oc_1', 'bridge UI 调整');
    store.dropCurrentSegment('oc_1');
    store.bindSegment('oc_1', 'sess-b', '/repo');

    expect(store.titleFor('sess-a')).toBe('bridge UI 调整');   // 名字跟着"这摊活"
    expect(store.titleFor('sess-b')).toBe('bridge UI 调整');
  });

  it('starts the next work session on demand and keeps the old one', async () => {
    const store = new WorkSessionStore(file);
    stores.push(store);
    await store.load();
    store.bindSegment('oc_1', 'sess-a', '/repo');
    store.startWorkSession('oc_1');                 // 相当于 /work
    expect(store.activeWorkSession('oc_1')).toBeUndefined();
    store.bindSegment('oc_1', 'sess-b', '/repo', { startedAtMs: 5, lastActiveAtMs: 5 });
    expect(store.activeWorkSession('oc_1')?.id).toBe('sess-b');
    expect(store.workSessionById('sess-a')?.segments).toHaveLength(1);   // 旧工作还在
  });

  it('carries a pending name into the next work session and clears it', async () => {
    const store = new WorkSessionStore(file);
    stores.push(store);
    await store.load();
    store.bindSegment('oc_1', 'sess-a', '/repo');
    store.startWorkSession('oc_1', '  新的活  ');
    store.bindSegment('oc_1', 'sess-b', '/repo');

    expect(store.activeWorkSession('oc_1')?.id).toBe('sess-b');
    expect(store.titleFor('sess-b')).toBe('新的活');
    expect(store.titleFor('sess-a')).toBeUndefined();

    // 名字只给下一摊活用一次：再开一摊不再复用它。
    store.startWorkSession('oc_1');
    store.bindSegment('oc_1', 'sess-c', '/repo');
    expect(store.titleFor('sess-c')).toBeUndefined();
  });

  it('starts an unnamed work session when /work has no name', async () => {
    const store = new WorkSessionStore(file);
    stores.push(store);
    await store.load();
    store.bindSegment('oc_1', 'sess-a', '/repo');
    store.startWorkSession('oc_1');
    store.bindSegment('oc_1', 'sess-b', '/repo');
    expect(store.titleFor('sess-b')).toBeUndefined();
  });

  it('does not leak a pending name when /work is re-run without one', async () => {
    const store = new WorkSessionStore(file);
    stores.push(store);
    await store.load();
    store.bindSegment('oc_1', 'sess-a', '/repo');
    store.startWorkSession('oc_1', '先起的名');   // /work 名字
    store.startWorkSession('oc_1');               // 反悔：再 /work 不带名字
    store.bindSegment('oc_1', 'sess-b', '/repo');

    expect(store.titleFor('sess-b')).toBeUndefined();
  });

  it('does not leak a pending name across /resume then an unnamed /work', async () => {
    const store = new WorkSessionStore(file);
    stores.push(store);
    await store.load();
    store.bindSegment('oc_1', 'sess-a', '/repo');
    store.startWorkSession('oc_1', '先起的名');   // /work 名字
    store.adoptWorkSession('oc_1', 'sess-a');      // /resume 旧工作
    store.startWorkSession('oc_1');                // 再 /work（无名）
    store.bindSegment('oc_1', 'sess-b', '/repo');

    expect(store.titleFor('sess-b')).toBeUndefined();
  });

  it('lists a scope once even after /work archived earlier sessions', async () => {
    const store = new WorkSessionStore(file);
    stores.push(store);
    await store.load();
    store.bindSegment('oc_1', 'sess-a', '/repo');
    store.startWorkSession('oc_1');                // 归档：同一 chat 又有活
    store.bindSegment('oc_1', 'sess-b', '/repo');
    store.bindSegment('oc_2', 'sess-c', '/repo');

    // 启动通知按 scope 发；同一 chat 的两摊活只该通知一次。
    expect(store.chats().sort()).toEqual(['oc_1', 'oc_2']);
  });

  it('keeps the idle override on the scope across work sessions', async () => {
    const store = new WorkSessionStore(file);
    stores.push(store);
    await store.load();
    store.bindSegment('oc_1', 'sess-a', '/repo');
    store.setIdleTimeoutMinutes('oc_1', 30);
    store.dropCurrentSegment('oc_1');
    store.startWorkSession('oc_1');
    store.bindSegment('oc_1', 'sess-b', '/repo');

    expect(store.getIdleTimeoutMinutes('oc_1')).toBe(30);
  });

  it('finds the work session a segment belongs to', async () => {
    const store = new WorkSessionStore(file);
    stores.push(store);
    await store.load();
    store.bindSegment('oc_1', 'sess-a', '/repo');
    store.dropCurrentSegment('oc_1');
    store.bindSegment('oc_1', 'sess-b', '/repo');

    expect(store.workSessionForSegment('sess-a')?.id).toBe('sess-a');
    expect(store.workSessionForSegment('sess-b')?.id).toBe('sess-a');
    expect(store.workSessionForSegment('nope')).toBeUndefined();
  });

  it('keeps scope references for manually-edited v2 files', async () => {
    await writeFileAtomic(file, JSON.stringify({
      v: 2,
      scopes: {},
      workSessions: {
        'sess-a': {
          id: 'sess-a', scope: 'oc_1', cwd: '/repo', createdAtMs: 1, lastActiveAtMs: 1,
          currentSegmentId: 'sess-a',
          segments: [{ sessionId: 'sess-a', cwd: '/repo', startedAtMs: 1, lastActiveAtMs: 1 }],
        },
      },
    }));
    const store = new WorkSessionStore(file);
    stores.push(store);
    await store.load();

    expect(store.activeWorkSession('oc_1')?.id).toBe('sess-a');
    await store.flush();
    const onDisk = JSON.parse(await readFile(file, 'utf8')) as { v: number };
    expect(onDisk.v).toBe(2);
  });

  it('backfills a missing scope link with the most recently active work session', async () => {
    // 同一 scope 下有两摊活（/work 归档过），文件里没留下 scope 映射。
    // 最近活跃的是 new；补链必须挑它，否则会静默绑到归档的旧活上。
    await writeFileAtomic(file, JSON.stringify({
      v: 2,
      scopes: {},
      workSessions: {
        'sess-new': {
          id: 'sess-new', scope: 'oc_1', cwd: '/repo', createdAtMs: 300, lastActiveAtMs: 300,
          currentSegmentId: 'sess-new',
          segments: [{ sessionId: 'sess-new', cwd: '/repo', startedAtMs: 300, lastActiveAtMs: 300 }],
        },
        'sess-old': {
          id: 'sess-old', scope: 'oc_1', cwd: '/repo', createdAtMs: 100, lastActiveAtMs: 100,
          currentSegmentId: 'sess-old',
          segments: [{ sessionId: 'sess-old', cwd: '/repo', startedAtMs: 100, lastActiveAtMs: 100 }],
        },
      },
    }));
    const store = new WorkSessionStore(file);
    stores.push(store);
    await store.load();

    expect(store.activeWorkSession('oc_1')?.id).toBe('sess-new');
  });
});
