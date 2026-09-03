import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { CommandContext } from '../index';
import { paths } from '../../config/paths';
import { searchSession } from './search';
import { renderSearchContext } from '../../card/search-card';

const origSessionsDir = paths.ompSessionsDir;
let tmp: string | undefined;

function ctxFor(workspaces: Record<string, string> = {}, titles: Record<string, string> = {}): CommandContext {
  return {
    workspaces: { listNamed: () => workspaces },
    sessions: { titlesBySessionId: () => titles },
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

  it('truncates results to the requested limit, newest first', async () => {
    tmp = await mkdtemp(join(tmpdir(), 'search-test-'));
    paths.ompSessionsDir = tmp;
    for (const [id, ts] of [
      ['a', '2026-08-15T10:00:00.000Z'],
      ['b', '2026-08-15T11:00:00.000Z'],
      ['c', '2026-08-15T12:00:00.000Z'],
    ] as Array<[string, string]>) {
      await writeSession(tmp, `${id}.jsonl`, { id, cwd: `/repo-${id}`, ts }, [
        { role: 'user', ts: `${ts.slice(0, 19)}Z`, content: [{ type: 'text', text: `codegraph in ${id}` }] },
      ]);
    }

    const capped = await searchSession('codegraph', ctxFor(), 2);
    expect(capped.map((h) => h.sessionId)).toEqual(['c', 'b']);

    const all = await searchSession('codegraph', ctxFor());
    expect(all.map((h) => h.sessionId)).toEqual(['c', 'b', 'a']);
  });

  it('matches case-insensitively', async () => {
    tmp = await mkdtemp(join(tmpdir(), 'search-test-'));
    paths.ompSessionsDir = tmp;
    await writeSession(tmp, 'a.jsonl', { id: 'a', cwd: '/r', ts: '2026-08-15T10:00:00.000Z' }, [
      { role: 'user', ts: '2026-08-15T10:00:01.000Z', content: [{ type: 'text', text: 'CodeGraph 用法' }] },
    ]);

    const hits = await searchSession('codegraph', ctxFor());
    expect(hits).toHaveLength(1);
    expect(hits[0]!.sessionId).toBe('a');
  });

  it('returns an empty array when nothing matches', async () => {
    tmp = await mkdtemp(join(tmpdir(), 'search-test-'));
    paths.ompSessionsDir = tmp;
    await writeSession(tmp, 'a.jsonl', { id: 'a', cwd: '/r', ts: '2026-08-15T10:00:00.000Z' }, [
      { role: 'user', ts: '2026-08-15T10:00:01.000Z', content: [{ type: 'text', text: '完全无关' }] },
    ]);

    await expect(searchSession('zzzz-not-found', ctxFor())).resolves.toEqual([]);
  });

  it('emits a single-message context for an assistant-only turn', async () => {
    tmp = await mkdtemp(join(tmpdir(), 'search-test-'));
    paths.ompSessionsDir = tmp;
    // Assistant message with no preceding user message → single-message pair.
    await writeSession(tmp, 'a.jsonl', { id: 'a', cwd: '/r', ts: '2026-08-15T10:00:00.000Z' }, [
      { role: 'assistant', ts: '2026-08-15T10:00:01.000Z', content: [{ type: 'text', text: 'codegraph 自述' }] },
    ]);

    const hits = await searchSession('codegraph', ctxFor());
    expect(hits).toHaveLength(1);
    expect(hits[0]!.messages).toHaveLength(1);
    expect(hits[0]!.messages[0]!.role).toBe('assistant');
    expect(hits[0]!.hitIndex).toBe(0);
  });

  it('excludes a user message whose only text is the system-prompt wrapper', async () => {
    tmp = await mkdtemp(join(tmpdir(), 'search-test-'));
    paths.ompSessionsDir = tmp;
    // The wrapper text contains the keyword but extractUserInput strips it.
    await writeSession(tmp, 'a.jsonl', { id: 'a', cwd: '/r', ts: '2026-08-15T10:00:00.000Z' }, [
      {
        role: 'user',
        ts: '2026-08-15T10:00:01.000Z',
        content: [
          {
            type: 'text',
            text: '<bridge_context>\nchat_id: x\n</bridge_context>\n你正在 feishu-omp-bridge 里运行，把 codegraph 转给本地。',
          },
        ],
      },
    ]);

    // The keyword appears in the raw file (so the prefilter passes) but the
    // extracted user input is empty → no searchable hit.
    const hits = await searchSession('codegraph', ctxFor());
    expect(hits).toEqual([]);
  });

  it('escapes a leading # in rendered message content', () => {
    const context = {
      messages: [
        { role: 'user' as const, content: '# 大标题\n> 引用行' },
        { role: 'assistant' as const, content: '正常回复' },
      ],
      hitIndex: 0,
    };
    const out = renderSearchContext(context, 'compact');
    // A leading # is backslash-escaped so it doesn't become a heading.
    expect(out).toContain('\\# 大标题');
    expect(out).not.toContain('\n# 大标题');
  });

  it('annotates hits with the session title from the store', async () => {
    tmp = await mkdtemp(join(tmpdir(), 'search-test-'));
    paths.ompSessionsDir = tmp;
    await writeSession(tmp, 'a.jsonl', { id: 'sessA', cwd: '/repoA', ts: '2026-08-15T10:00:00.000Z' }, [
      { role: 'user', ts: '2026-08-15T10:00:01.000Z', content: [{ type: 'text', text: 'codegraph 检索' }] },
    ]);
    // sessB has no title, must stay unlabeled.
    await writeSession(tmp, 'b.jsonl', { id: 'sessB', cwd: '/repoB', ts: '2026-08-15T11:00:00.000Z' }, [
      { role: 'user', ts: '2026-08-15T11:00:01.000Z', content: [{ type: 'text', text: 'codegraph 用法' }] },
    ]);

    const hits = await searchSession('codegraph', ctxFor({}, { sessA: '修搜索' }));
    const bySession = Object.fromEntries(hits.map((h) => [h.sessionId, h.title]));
    expect(bySession.sessA).toBe('修搜索');
    expect(bySession.sessB).toBeUndefined();
  });

  it('groups multiple hits from one session into a single context', async () => {
    tmp = await mkdtemp(join(tmpdir(), 'search-test-'));
    paths.ompSessionsDir = tmp;
    await writeSession(tmp, 'a.jsonl', { id: 'sessA', cwd: '/repo', ts: '2026-08-15T10:00:00.000Z' }, [
      { role: 'user', ts: '2026-08-15T10:00:01.000Z', content: [{ type: 'text', text: '第一处 codegraph 提问' }] },
      { role: 'assistant', ts: '2026-08-15T10:00:02.000Z', content: [{ type: 'text', text: '第一处 codegraph 回答' }] },
      { role: 'user', ts: '2026-08-15T10:00:03.000Z', content: [{ type: 'text', text: '第二处 codegraph 追问' }] },
      { role: 'assistant', ts: '2026-08-15T10:00:04.000Z', content: [{ type: 'text', text: '第二处 codegraph 回答' }] },
    ]);

    const hits = await searchSession('codegraph', ctxFor());
    expect(hits).toHaveLength(1);
    expect(hits[0]!.sessionId).toBe('sessA');
    expect(hits[0]!.matchCount).toBe(2);
    // Representative is the newest matching pair inside the session.
    expect(hits[0]!.messages.map((m) => m.content)).toEqual([
      '第二处 codegraph 追问',
      '第二处 codegraph 回答',
    ]);
  });
});
