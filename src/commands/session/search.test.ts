import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { CommandContext } from '../index';
import { paths } from '../../config/paths';
import { searchSession, renderSearchContext } from './search';

const origSessionsDir = paths.ompSessionsDir;
let tmp: string | undefined;

function ctxFor(workspaces: Record<string, string> = {}): CommandContext {
  return {
    workspaces: { listNamed: () => workspaces },
  } as CommandContext;
}

/** Write a minimal session file: session frame + a few message frames. */
async function writeSession(
  dir: string,
  fileName: string,
  session: { id: string; cwd: string; ts: string },
  messages: Array<{ role: string; ts: string; content: unknown }>,
): Promise<void> {
  const lines = [
    JSON.stringify({ type: 'session', id: session.id, cwd: session.cwd, timestamp: session.ts }),
    ...messages.map((m) =>
      JSON.stringify({
        type: 'message',
        timestamp: m.ts,
        message: { role: m.role, content: m.content },
      }),
    ),
  ];
  await writeFile(join(dir, fileName), lines.join('\n') + '\n', 'utf8');
}

afterEach(async () => {
  paths.ompSessionsDir = origSessionsDir;
  if (tmp) {
    await rm(tmp, { recursive: true, force: true });
    tmp = undefined;
  }
});

describe('searchSession', () => {
  it('searches across sessions and workspaces, newest first', async () => {
    tmp = await mkdtemp(join(tmpdir(), 'search-test-'));
    paths.ompSessionsDir = tmp;

    // Session A (older, cwd /repoA) — hit in a user message.
    await writeSession(tmp, 'sessA.jsonl', { id: 'sessA', cwd: '/repoA', ts: '2026-08-15T10:00:00.000Z' }, [
      { role: 'user', ts: '2026-08-15T10:00:01.000Z', content: [{ type: 'text', text: '帮我生成 codegraph 索引' }] },
      { role: 'assistant', ts: '2026-08-15T10:00:02.000Z', content: [{ type: 'text', text: '索引已生成。' }] },
    ]);

    // Session B (newer, cwd /repoB) — hit in another workspace.
    await writeSession(tmp, 'sessB.jsonl', { id: 'sessB', cwd: '/repoB', ts: '2026-08-15T11:00:00.000Z' }, [
      { role: 'user', ts: '2026-08-15T11:00:01.000Z', content: [{ type: 'text', text: 'codegraph 检索' }] },
    ]);

    // Session C — no "codegraph" anywhere; must be skipped by the prefilter.
    await writeSession(tmp, 'sessC.jsonl', { id: 'sessC', cwd: '/repoC', ts: '2026-08-15T12:00:00.000Z' }, [
      { role: 'user', ts: '2026-08-15T12:00:01.000Z', content: [{ type: 'text', text: '无关内容' }] },
    ]);

    // Session D — "codegraph" only inside thinking; not a visible text hit.
    await writeSession(tmp, 'sessD.jsonl', { id: 'sessD', cwd: '/repoD', ts: '2026-08-15T09:00:00.000Z' }, [
      {
        role: 'assistant',
        ts: '2026-08-15T09:00:01.000Z',
        content: [
          { type: 'thinking', thinking: 'codegraph 思考过程' },
          { type: 'text', text: '可见回复' },
        ],
      },
    ]);

    const hits = await searchSession('codegraph', ctxFor());

    expect(hits).toHaveLength(2);
    // Newest hit first: session B (11:00) precedes session A (10:00).
    expect(hits[0]!.sessionId).toBe('sessB');
    expect(hits[0]!.workspace).toBe('/repoB');
    expect(hits[1]!.sessionId).toBe('sessA');
    expect(hits[1]!.workspace).toBe('/repoA');
    // sessC (no keyword) and sessD (keyword only in thinking) are excluded.
    expect(hits.map((h) => h.sessionId)).not.toContain('sessC');
    expect(hits.map((h) => h.sessionId)).not.toContain('sessD');
  });

  it('resolves workspace label from a named workspace', async () => {
    tmp = await mkdtemp(join(tmpdir(), 'search-test-'));
    paths.ompSessionsDir = tmp;

    await writeSession(tmp, 'sessA.jsonl', { id: 'sessA', cwd: '/home/futu', ts: '2026-08-15T10:00:00.000Z' }, [
      { role: 'user', ts: '2026-08-15T10:00:01.000Z', content: [{ type: 'text', text: 'codegraph' }] },
    ]);

    const hits = await searchSession('codegraph', ctxFor({ futu: '/home/futu' }));
    expect(hits).toHaveLength(1);
    expect(hits[0]!.workspace).toBe('futu');
  });

  it('returns one Q&A pair per hit and dedupes when both halves match', async () => {
    tmp = await mkdtemp(join(tmpdir(), 'search-test-'));
    paths.ompSessionsDir = tmp;

    // Both the question and the answer contain "codegraph"; the pair must be
    // emitted exactly once, as [user, assistant] with hitIndex 0.
    await writeSession(tmp, 'sessA.jsonl', { id: 'sessA', cwd: '/repo', ts: '2026-08-15T10:00:00.000Z' }, [
      { role: 'user', ts: '2026-08-15T10:00:01.000Z', content: [{ type: 'text', text: '怎么用 codegraph' }] },
      { role: 'assistant', ts: '2026-08-15T10:00:02.000Z', content: [{ type: 'text', text: 'codegraph 用法是…' }] },
    ]);

    const hits = await searchSession('codegraph', ctxFor());
    expect(hits).toHaveLength(1);
    expect(hits[0]!.messages.map((m) => m.role)).toEqual(['user', 'assistant']);
    expect(hits[0]!.hitIndex).toBe(0);
    expect(hits[0]!.messages[0]!.content).toBe('怎么用 codegraph');
    expect(hits[0]!.messages[1]!.content).toBe('codegraph 用法是…');
  });

  it('matches an assistant answer anchored on its preceding question', async () => {
    tmp = await mkdtemp(join(tmpdir(), 'search-test-'));
    paths.ompSessionsDir = tmp;

    // Only the assistant reply matches; the pair is [question, answer] with
    // hitIndex pointing at the assistant message.
    await writeSession(tmp, 'sessA.jsonl', { id: 'sessA', cwd: '/repo', ts: '2026-08-15T10:00:00.000Z' }, [
      { role: 'user', ts: '2026-08-15T10:00:01.000Z', content: [{ type: 'text', text: '讲讲索引' }] },
      { role: 'assistant', ts: '2026-08-15T10:00:02.000Z', content: [{ type: 'text', text: 'codegraph 索引已生成' }] },
    ]);

    const hits = await searchSession('codegraph', ctxFor());
    expect(hits).toHaveLength(1);
    expect(hits[0]!.messages.map((m) => m.role)).toEqual(['user', 'assistant']);
    expect(hits[0]!.hitIndex).toBe(1);
    expect(hits[0]!.messages[0]!.content).toBe('讲讲索引');
    expect(hits[0]!.messages[1]!.content).toBe('codegraph 索引已生成');
  });

  it('caps message length in compact and detail modes', () => {
    const context = {
      messages: [
        { role: 'user' as const, content: 'q'.repeat(2000) },
        { role: 'assistant' as const, content: 'a'.repeat(2000) },
      ],
      hitIndex: 0,
    };
    const compact = renderSearchContext(context, 'compact');
    // user capped at 80, assistant at 120 (plus ellipsis).
    expect(compact).toContain('q'.repeat(80) + '…');
    expect(compact).toContain('a'.repeat(120) + '…');
    expect(compact).not.toContain('q'.repeat(81));
    const detail = renderSearchContext(context, 'detail');
    // user capped at 600, assistant at 1000.
    expect(detail).toContain('q'.repeat(600) + '…');
    expect(detail).toContain('a'.repeat(1000) + '…');
  });
});
