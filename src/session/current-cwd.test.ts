import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { conversationCwd, resolveConversationCwd } from './current-cwd';
import { SessionStore } from './store';
import { WorkspaceStore } from '../workspace/store';

let dir: string;
let file: string;
let stores: SessionStore[];
let spaces: WorkspaceStore[];

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'cwd-test-'));
  file = join(dir, 'sessions.json');
  stores = [];
  spaces = [];
});
afterEach(async () => {
  await Promise.all([...stores, ...spaces].map((s) => s.flush()));
  await rm(dir, { recursive: true, force: true });
});

async function stores_(): Promise<{ sessions: SessionStore; workspaces: WorkspaceStore }> {
  const sessions = new SessionStore(file);
  stores.push(sessions);
  await sessions.load();
  const workspaces = new WorkspaceStore(join(dir, 'workspaces.json'));
  spaces.push(workspaces);
  await workspaces.load();
  return { sessions, workspaces };
}

describe('resolveConversationCwd（运行用）', () => {
  it('会话优先：聊天窗口的 cwd 与会话不一致时，用会话自己的目录并把它同步给窗口', async () => {
    const { sessions, workspaces } = await stores_();
    const sessionDir = await mkdtemp(join(tmpdir(), 'conv-'));
    sessions.bind('oc_1', 'sess-1', sessionDir, { createdAtMs: 1, updatedAtMs: 1 });
    workspaces.setCwd('oc_1', dir); // 聊天窗口指到别处

    const out = await resolveConversationCwd(workspaces, sessions, 'oc_1');

    expect(out).toEqual({ cwd: sessionDir, sessionId: 'sess-1' });
    // 窗口跟随会话：从此 cwd 的唯一真相是会话。
    expect(workspaces.cwdFor('oc_1')).toBe(sessionDir);
    await rm(sessionDir, { recursive: true, force: true });
  });

  it('没有当前会话时用聊天窗口的 cwd（新对话将落在那里）', async () => {
    const { sessions, workspaces } = await stores_();
    workspaces.setCwd('oc_1', dir);

    expect(await resolveConversationCwd(workspaces, sessions, 'oc_1')).toEqual({ cwd: dir });
  });

  it('会话目录已不存在（被删/改名）→ 不假装能续，退回窗口 cwd', async () => {
    const { sessions, workspaces } = await stores_();
    const gone = join(dir, 'deleted-dir');
    sessions.bind('oc_1', 'sess-gone', gone, { createdAtMs: 1, updatedAtMs: 1 });
    workspaces.setCwd('oc_1', dir);

    expect(await resolveConversationCwd(workspaces, sessions, 'oc_1')).toEqual({ cwd: dir });
  });

  it('窗口 cwd 也不存在 → 修到 $HOME 并回写（否则 omp spawn 必 ENOENT）', async () => {
    const { sessions, workspaces } = await stores_();
    const home = await mkdtemp(join(tmpdir(), 'home-'));
    workspaces.setCwd('oc_1', join(dir, 'nope'));

    expect(await resolveConversationCwd(workspaces, sessions, 'oc_1', home)).toEqual({ cwd: home });
    expect(workspaces.cwdFor('oc_1')).toBe(home);
    await rm(home, { recursive: true, force: true });
  });
});

describe('conversationCwd（只读口径）', () => {
  it('会话优先，且不写任何状态', async () => {
    const { sessions, workspaces } = await stores_();
    const sessionDir = await mkdtemp(join(tmpdir(), 'conv-'));
    sessions.bind('oc_1', 'sess-1', sessionDir, { createdAtMs: 1, updatedAtMs: 1 });
    workspaces.setCwd('oc_1', dir);

    expect(conversationCwd(workspaces, sessions, 'oc_1')).toBe(sessionDir);
    // 只读：窗口的 cwd 没被改写（改写只发生在运行前）。
    expect(workspaces.cwdFor('oc_1')).toBe(dir);
    await rm(sessionDir, { recursive: true, force: true });
  });

  it('没有会话时退回窗口 cwd；两者都没有时退回传入的 home', async () => {
    const { sessions, workspaces } = await stores_();
    expect(conversationCwd(workspaces, sessions, 'oc_1', '/fallback')).toBe('/fallback');
    workspaces.setCwd('oc_1', dir);
    expect(conversationCwd(workspaces, sessions, 'oc_1', '/fallback')).toBe(dir);
  });
});
