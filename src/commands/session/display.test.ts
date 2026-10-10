import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CommandContext } from '../index';
import { WorkSessionStore } from '../../session/work-store';
import * as contextModule from './context';
import { resolveWorkSessionDisplay, workSessionName } from './display';

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

describe('workSessionName', () => {
  it('returns the trimmed title, else undefined — synchronously', () => {
    store.bindSegment('oc_1', 'sess-a', root);
    const ws = store.activeWorkSession('oc_1')!;
    expect(workSessionName(makeCtx(), ws)).toBeUndefined();

    store.setTitle('oc_1', '  修搜索  ');
    expect(workSessionName(makeCtx(), store.activeWorkSession('oc_1')!)).toBe('修搜索');
    expect(workSessionName(makeCtx(), undefined)).toBeUndefined();
  });
});

describe('resolveWorkSessionDisplay', () => {
  it('有 title 时不扫目录（loadSessionSummary 未被调用）', async () => {
    store.bindSegment('oc_1', 'sess-a', root);
    store.setTitle('oc_1', 'KMP 导出');
    const spy = vi.spyOn(contextModule, 'loadSessionSummary');

    const out = await resolveWorkSessionDisplay(makeCtx(), store.activeWorkSession('oc_1')!);

    expect(out).toEqual({ name: 'KMP 导出' });
    expect(spy).not.toHaveBeenCalled();
  });

  it('无 title 时取当前段（优先）的最后一条用户消息作为 topic', async () => {
    store.bindSegment('oc_1', 'sess-old', root);
    store.bindSegment('oc_1', 'sess-new', root);
    await writeSessionFile('sess-old', '旧段的消息');
    await writeSessionFile('sess-new', '当前段的消息');

    const out = await resolveWorkSessionDisplay(makeCtx(), store.activeWorkSession('oc_1')!);

    expect(out).toEqual({ topic: '当前段的消息' });
  });

  it('没有当前段时退回最新段的最后一条用户消息', async () => {
    store.bindSegment('oc_1', 'sess-old', root);
    store.bindSegment('oc_1', 'sess-new', root);
    await writeSessionFile('sess-old', '旧段的消息');
    await writeSessionFile('sess-new', '最新段的消息');
    store.dropCurrentSegment('oc_1');

    const out = await resolveWorkSessionDisplay(makeCtx(), store.activeWorkSession('oc_1')!);

    expect(out).toEqual({ topic: '最新段的消息' });
  });

  it('取不到名字/消息时两者都缺省（undefined）', async () => {
    store.bindSegment('oc_1', 'sess-a', root); // 目录里没有 sess-a 的 JSONL

    const out = await resolveWorkSessionDisplay(makeCtx(), store.activeWorkSession('oc_1')!);

    expect(out.name).toBeUndefined();
    expect(out.topic).toBeUndefined();
  });

  it('没有工作会话时返回空对象，不触碰会话目录', async () => {
    const spy = vi.spyOn(contextModule, 'loadSessionSummary');

    const out = await resolveWorkSessionDisplay(makeCtx(), undefined);

    expect(out).toEqual({});
    expect(spy).not.toHaveBeenCalled();
  });
});
