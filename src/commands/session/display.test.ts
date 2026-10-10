import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CommandContext } from '../index';
import { WorkSessionStore } from '../../session/work-store';
import { sessionName } from './display';

let root: string;
let ompDir: string;
let store: WorkSessionStore;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'display-test-'));
  ompDir = join(root, 'omp');
  await mkdir(ompDir, { recursive: true });
  store = new WorkSessionStore(join(root, 'sessions.json'));
  await store.load();
});

afterEach(async () => {
  vi.restoreAllMocks();
  await store.flush();
  await rm(root, { recursive: true, force: true });
});

function makeCtx(): CommandContext {
  return {
    scope: 'oc_1',
    workSessions: store,
    workspaces: { cwdFor: () => root },
    controls: { cfg: { preferences: { ompSessionDir: ompDir } } },
  } as unknown as CommandContext;
}

/** Write a real OMP session file for `sessionId` with one user message. */
async function writeSessionFile(sessionId: string, userText: string): Promise<void> {
  await writeFile(
    join(ompDir, `${sessionId}.jsonl`),
    [
      JSON.stringify({ type: 'session', id: sessionId, cwd: root, timestamp: 't0' }),
      JSON.stringify({
        type: 'message',
        message: { role: 'user', content: [{ type: 'text', text: userText }] },
      }),
    ].join('\n'),
    'utf8',
  );
}

describe('sessionName', () => {
  it('returns the trimmed title, else undefined — synchronously', () => {
    store.bindSegment('oc_1', 'sess-a', root);
    const ws = store.activeWorkSession('oc_1')!;
    expect(sessionName(ws)).toBeUndefined();

    store.setTitle('oc_1', '  修搜索  ');
    expect(sessionName(store.activeWorkSession('oc_1')!)).toBe('修搜索');
    expect(sessionName(undefined)).toBeUndefined();
  });
});
