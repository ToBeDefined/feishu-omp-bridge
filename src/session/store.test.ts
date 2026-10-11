import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SessionStore } from './store';

vi.mock('../core/logger', () => ({ log: { info: vi.fn(), warn: vi.fn(), fail: vi.fn() } }));

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

async function open(): Promise<SessionStore> {
  const store = new SessionStore(file);
  stores.push(store);
  await store.load();
  return store;
}

const read = async (): Promise<Record<string, unknown>> =>
  JSON.parse(await readFile(file, 'utf8')) as Record<string, unknown>;

describe('SessionStore 会话绑定', () => {
  it('bind 记住当前会话及其自己的 cwd；sessionFor 按原样取回', async () => {
    const store = await open();
    store.bind('oc_1', 'sess-a', '/repo');
    expect(store.sessionFor('oc_1')).toEqual({ sessionId: 'sess-a', cwd: '/repo' });
    expect(store.chats()).toEqual(['oc_1']);
  });

  it('同一会话重跑只推时间，createdAt 保留', async () => {
    const store = await open();
    store.bind('oc_1', 'sess-a', '/repo', { createdAtMs: 1_000, updatedAtMs: 1_000 });
    store.bind('oc_1', 'sess-a', '/repo', { updatedAtMs: 9_000 });

    const entry = store.getRaw('oc_1');
    expect(entry?.createdAt).toBe(1_000);
    expect(entry?.updatedAt).toBe(9_000);
  });

  it('换会话时采用**那条会话自己的**时间，不继承上一条', async () => {
    const store = await open();
    store.bind('oc_1', 'sess-a', '/repo/a', { createdAtMs: 5, updatedAtMs: 5 });
    store.bind('oc_1', 'sess-b', '/repo/b', { createdAtMs: 1_000, updatedAtMs: 2_000 });

    expect(store.getRaw('oc_1')).toMatchObject({
      sessionId: 'sess-b',
      cwd: '/repo/b',
      createdAt: 1_000,
      updatedAt: 2_000,
    });
  });

  it('startNew 丢掉会话指针，但保留 /timeout 覆盖（下一条消息开新对话）', async () => {
    const store = await open();
    store.bind('oc_1', 'sess-a', '/repo');
    store.setIdleTimeoutMinutes('oc_1', 30);

    store.startNew('oc_1');

    expect(store.sessionFor('oc_1')).toBeUndefined();
    expect(store.getIdleTimeoutMinutes('oc_1')).toBe(30);
  });
});

describe('SessionStore 名字（按会话 id）', () => {
  it('命名的是当前会话；换走再换回来名字还在', async () => {
    const store = await open();
    store.bind('oc_1', 'sess-a', '/repo');
    expect(store.setTitle('oc_1', '修搜索')).toBe(true);

    // 换到另一条会话：它没有被命名；旧会话的名字挂在它自己身上。
    store.startNew('oc_1');
    store.bind('oc_1', 'sess-b', '/repo');
    expect(store.titleFor('sess-b')).toBeUndefined();
    expect(store.titleFor('sess-a')).toBe('修搜索');

    // 换回旧会话 → 名字自然还在（不用搬任何东西）。
    store.bind('oc_1', 'sess-a', '/repo');
    expect(store.titleFor('sess-a')).toBe('修搜索');
  });

  it('没有当前会话时不许命名；清名只在真有名字时返回 true', async () => {
    const store = await open();
    expect(store.setTitle('oc_1', 'x')).toBe(false);
    store.bind('oc_1', 'sess-a', '/repo');

    expect(store.clearTitle('oc_1')).toBe(false);
    store.setTitle('oc_1', '后来起的');
    expect(store.clearTitle('oc_1')).toBe(true);
    expect(store.titleFor('sess-a')).toBeUndefined();
  });

  it('setTitleFor 按会话 id 写（/rename auto 生成期间会话可能已换掉）', async () => {
    const store = await open();
    store.bind('oc_1', 'sess-a', '/repo');
    store.startNew('oc_1');
    store.bind('oc_1', 'sess-b', '/repo');

    // 生成标题时目标还是 sess-a：必须落在它身上，不能落到 sess-b。
    store.setTitleFor('sess-a', '自动标题');
    expect(store.titleFor('sess-a')).toBe('自动标题');
    expect(store.titleFor('sess-b')).toBeUndefined();
  });
});

describe('SessionStore 持久化与迁移', () => {
  it('v3 落盘形状：scopes + 全局 titles', async () => {
    const store = await open();
    store.bind('oc_1', 'sess-a', '/repo');
    store.setTitle('oc_1', '名字');
    await store.flush();

    const raw = await read();
    expect(raw.v).toBe(3);
    expect(raw.titles).toEqual({ 'sess-a': '名字' });
    expect((raw.scopes as Record<string, unknown>).oc_1).toMatchObject({
      sessionId: 'sess-a',
      cwd: '/repo',
    });
  });

  it('v2（工作会话 + 段）就地迁移到 v3：会话 = 当前段，名字挂到工作会话 id', async () => {
    await writeFile(
      file,
      JSON.stringify({
        v: 2,
        scopes: { oc_1: { activeWorkSession: 'sess-a' } },
        workSessions: {
          'sess-a': {
            id: 'sess-a',
            scope: 'oc_1',
            title: '旧名字',
            cwd: '/repo',
            createdAtMs: 111,
            lastActiveAtMs: 222,
            currentSegmentId: 'sess-b',
            segments: [
              { sessionId: 'sess-a', cwd: '/repo', startedAtMs: 111, lastActiveAtMs: 111 },
              { sessionId: 'sess-b', cwd: '/repo2', startedAtMs: 5, lastActiveAtMs: 6 },
            ],
          },
        },
      }),
      'utf8',
    );
    const store = await open();

    // 当前会话 = 该工作会话的当前段（连带它的 cwd/时间）。
    expect(store.sessionFor('oc_1')).toEqual({ sessionId: 'sess-b', cwd: '/repo2' });
    expect(store.getRaw('oc_1')?.createdAt).toBe(5);
    expect(store.getRaw('oc_1')?.updatedAt).toBe(222);
    // v2 的名字挂在当前段上（用户当时就在那条会话里）。
    expect(store.titleFor('sess-b')).toBe('旧名字');
    // 迁移前留档 + 立刻写回 v3。
    expect(await readFile(`${file}.v2.bak`, 'utf8')).toContain('"workSessions"');
    await store.flush();
    expect((await read()).v).toBe(3);
  });

  it('v1（chat 级会话 + 标题）迁移到 v3：标题落到它当时绑定的会话上', async () => {
    await writeFile(
      file,
      JSON.stringify({
        oc_1: { sessionId: 'sess-a', cwd: '/repo', updatedAt: 42, createdAt: 41, title: '老标题' },
        oc_2: { sessionId: 'sess-b', cwd: '/repo', updatedAt: 43, idleTimeoutMinutes: 15 },
      }),
      'utf8',
    );
    const store = await open();

    expect(store.sessionFor('oc_1')).toEqual({ sessionId: 'sess-a', cwd: '/repo' });
    expect(store.getRaw('oc_1')?.createdAt).toBe(41);
    expect(store.titleFor('sess-a')).toBe('老标题');
    expect(store.getIdleTimeoutMinutes('oc_2')).toBe(15);
    expect(await readFile(`${file}.v1.bak`, 'utf8')).toContain('"老标题"');
  });

  it('没有会话指针但有 /timeout 覆盖的条目要留下（否则用户设的探活会丢）', async () => {
    await writeFile(file, JSON.stringify({ oc_1: { updatedAt: 7, idleTimeoutMinutes: 20 } }), 'utf8');
    const store = await open();

    expect(store.sessionFor('oc_1')).toBeUndefined();
    expect(store.getIdleTimeoutMinutes('oc_1')).toBe(20);
  });

  it('文件坏掉时从空状态开始，不让 daemon 起不来', async () => {
    await writeFile(file, '{ not json', 'utf8');
    const store = new SessionStore(file);
    stores.push(store);
    await store.load();

    expect(store.chats()).toEqual([]);
    expect(store.titleFor('anything')).toBeUndefined();
  });

  it('persist:false 只读不写（CLI / 校验用）', async () => {
    const before = JSON.stringify({ oc_1: { sessionId: 'sess-a', cwd: '/repo', updatedAt: 42 } });
    await writeFile(file, before, 'utf8');
    const store = new SessionStore(file);
    stores.push(store);
    await store.load({ persist: false });
    await store.flush();

    expect(store.sessionFor('oc_1')).toEqual({ sessionId: 'sess-a', cwd: '/repo' });
    expect(await readFile(file, 'utf8')).toBe(before);
  });
});
