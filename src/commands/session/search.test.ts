import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { CommandContext } from '../index';
import { paths } from '../../config/paths';
import {
  detailInfoFor,
  searchSession,
  searchHandlers,
  SEARCH_SESSION_LIMIT,
  workspaceLabel,
} from './search';
import { loadSessionSummary } from './context';
import { renderSearchContext, SEARCH_PAGE_SIZE, searchResultsCard } from '../../card/search-card';
import { SessionStore } from '../../session/store';

const { reply } = vi.hoisted(() => ({
  reply: vi.fn(async (_ctx: unknown, _text: string) => {}),
}));

vi.mock('../shared', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../shared')>();
  return { ...actual, reply, recallMessage: vi.fn(async () => {}) };
});

// Wrap loadSessionSummary so we can prove /search resolves identities from its
// own scan instead of rescanning the session dir per session.
vi.mock('./context', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./context')>();
  return { ...actual, loadSessionSummary: vi.fn(actual.loadSessionSummary) };
});

const origSessionsDir = paths.ompSessionsDir;
let tmp: string | undefined;

function ctxFor(
  workspaces: Record<string, string> = {},
  sessions?: { titleFor: (sessionId: string | undefined) => string | undefined },
): CommandContext {
  return {
    workspaces: { listNamed: () => workspaces },
    sessions: sessions ?? { titleFor: () => undefined },
    controls: { cfg: {} },
  } as CommandContext;
}

describe('detailInfoFor', () => {
  it('marks the conversation the scope is already on', () => {
    const hit = {
      sessionId: 'sess-a',
      workspace: '~/repo',
      matchCount: 1,
      groups: [{ messages: [{ role: 'user' as const, content: 'x' }], hitIndex: 0, matchCount: 1 }],
      messages: [{ role: 'user' as const, content: 'x' }],
      hitIndex: 0,
    };
    const marked = detailInfoFor(hit, 'q1', 1, { currentSessionId: 'sess-a' });
    expect(marked.current).toBe(true);
    expect(marked.queryRef).toBe('q1 1');
    // 别的会话 / 没有当前会话 → 不标记，保留「继续对话」。
    expect(detailInfoFor(hit, 'q1', 1, { currentSessionId: 'sess-b' }).current).toBeUndefined();
    expect(detailInfoFor(hit, 'q1', 1, {}).current).toBeUndefined();
    // 永远带 queryRef（卡片自身记作用）。
    expect(marked.queryRef).toBe('q1 1');
    // 详情卡带上 queryId + 进入时的 offset，返回时回到同一页。
    expect(marked.queryId).toBe('q1');
    expect(detailInfoFor(hit, 'q1', 7, { offset: 6 }).offset).toBe(6);
    // 没给 offset 就不写（卡片按行号推算）。
    expect(marked.offset).toBeUndefined();
  });
});

describe('workspaceLabel', () => {
  it('returns the named workspace when cwd matches', () => {
    const ctx = ctxFor({ bridge: '/Users/tbd/bridge' });
    expect(workspaceLabel(ctx, '/Users/tbd/bridge')).toBe('bridge');
  });

  it('returns raw cwd when no named workspace matches', () => {
    const ctx = ctxFor({ other: '/tmp/x' });
    expect(workspaceLabel(ctx, '/Users/tbd/code')).toBe('/Users/tbd/code');
  });
});

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
    // 一行一条：user 56 字符、assistant 88 字符（各带省略号）。
    expect(compact).toContain('q'.repeat(56) + '…');
    expect(compact).toContain('a'.repeat(88) + '…');
    expect(compact).not.toContain('q'.repeat(57));
    // 压缩成一行：两条消息 = 两行，不再是各自的 role 行 + 引用块。
    expect(compact.split('\n')).toHaveLength(2);
    const detail = renderSearchContext(context, 'detail');
    // user capped at 600, assistant at 1000；截断标记落在引用块内（`> …`），
    // 原文换行保留。
    expect(detail).toContain('q'.repeat(600) + '\n> …');
    expect(detail).toContain('a'.repeat(1000) + '\n> …');
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

  it('uses the session title as the row identity', async () => {
    tmp = await mkdtemp(join(tmpdir(), 'search-test-'));
    paths.ompSessionsDir = tmp;
    await writeSession(tmp, 'a.jsonl', { id: 'sessA', cwd: '/repoA', ts: '2026-08-15T10:00:00.000Z' }, [
      { role: 'user', ts: '2026-08-15T10:00:01.000Z', content: [{ type: 'text', text: 'codegraph 检索' }] },
    ]);
    // sessB has no title → stays unlabeled (topic fallback instead).
    await writeSession(tmp, 'b.jsonl', { id: 'sessB', cwd: '/repoB', ts: '2026-08-15T11:00:00.000Z' }, [
      { role: 'user', ts: '2026-08-15T11:00:01.000Z', content: [{ type: 'text', text: 'codegraph 用法' }] },
    ]);
    const store = new SessionStore(join(tmp, 'sessions.json'));
    await store.load();
    store.bind('oc_1', 'sessA', '/repoA');
    store.setTitle('oc_1', '修搜索');

    const hits = await searchSession('codegraph', ctxFor({}, store));
    const bySession = Object.fromEntries(hits.map((h) => [h.sessionId, h.title]));
    expect(bySession.sessA).toBe('修搜索');
    expect(bySession.sessB).toBeUndefined();
    await store.flush();
  });

  it('falls back to the last user message when the session is unnamed', async () => {
    tmp = await mkdtemp(join(tmpdir(), 'search-test-'));
    paths.ompSessionsDir = tmp;
    await writeSession(tmp, 'segA.jsonl', { id: 'segA', cwd: '/repo', ts: '2026-08-15T10:00:00.000Z' }, [
      { role: 'user', ts: '2026-08-15T10:00:01.000Z', content: [{ type: 'text', text: '最后一条用户消息 codegraph' }] },
    ]);
    const store = new SessionStore(join(tmp, 'sessions.json'));
    await store.load();
    store.bind('oc_1', 'segA', '/repo');

    const hits = await searchSession('codegraph', ctxFor({}, store));
    expect(hits).toHaveLength(1);
    expect(hits[0]!.title).toBeUndefined();
    expect(hits[0]!.topic).toBe('最后一条用户消息 codegraph');
    await store.flush();
  });

  it('无名会话解析不触发额外目录扫描（不调 loadSessionSummary）', async () => {
    tmp = await mkdtemp(join(tmpdir(), 'search-test-'));
    paths.ompSessionsDir = tmp;
    await writeSession(tmp, 'segA.jsonl', { id: 'segA', cwd: '/repo', ts: '2026-08-15T10:00:00.000Z' }, [
      { role: 'user', ts: '2026-08-15T10:00:01.000Z', content: [{ type: 'text', text: 'codegraph 最后一条' }] },
    ]);
    const store = new SessionStore(join(tmp, 'sessions.json'));
    await store.load();
    store.bind('oc_1', 'segA', '/repo');
    vi.mocked(loadSessionSummary).mockClear();

    const hits = await searchSession('codegraph', ctxFor({}, store));

    expect(hits).toHaveLength(1);
    expect(hits[0]!.topic).toBe('codegraph 最后一条');
    expect(loadSessionSummary).not.toHaveBeenCalled();
    await store.flush();
  });

  it('fabricates no title when a session has neither name nor user message', async () => {
    tmp = await mkdtemp(join(tmpdir(), 'search-test-'));
    paths.ompSessionsDir = tmp;
    // Assistant-only turn: no real user message to fall back to.
    await writeSession(tmp, 'segA.jsonl', { id: 'segA', cwd: '/repo', ts: '2026-08-15T10:00:00.000Z' }, [
      { role: 'assistant', ts: '2026-08-15T10:00:02.000Z', content: [{ type: 'text', text: 'codegraph 回答' }] },
    ]);
    const store = new SessionStore(join(tmp, 'sessions.json'));
    await store.load();
    store.bind('oc_1', 'segA', '/repo');

    const hits = await searchSession('codegraph', ctxFor({}, store));
    expect(hits).toHaveLength(1);
    expect(hits[0]!.title).toBeUndefined();
    expect(hits[0]!.topic).toBeUndefined();
    // Heading is just the row number — no invented identity.
    const card = JSON.stringify(searchResultsCard('codegraph', hits, 'q1'));
    // 行身份是普通字号（`**#1** _未命名会话_`），只有卡片标题是 heading。
    expect(card).toContain('"content":"**#1** _未命名会话_"');
    await store.flush();
  });

  it('每个 OMP 会话各占一行，标题或最后一条用户消息作为身份', async () => {
    tmp = await mkdtemp(join(tmpdir(), 'search-test-'));
    paths.ompSessionsDir = tmp;
    await writeSession(tmp, 'segA.jsonl', { id: 'segA', cwd: '/repo', ts: '2026-08-15T10:00:00.000Z' }, [
      { role: 'user', ts: '2026-08-15T10:00:01.000Z', content: [{ type: 'text', text: '第一段 codegraph' }] },
    ]);
    await writeSession(tmp, 'segB.jsonl', { id: 'segB', cwd: '/repo', ts: '2026-08-15T11:00:00.000Z' }, [
      { role: 'user', ts: '2026-08-15T11:00:01.000Z', content: [{ type: 'text', text: '第二段 codegraph' }] },
    ]);
    const store = new SessionStore(join(tmp, 'sessions.json'));
    await store.load();
    store.bind('oc_1', 'segA', '/repo');
    // 新对话（/new 等）开新的一摊：segB 不并入 segA 的行。
    store.startNew('oc_1');
    store.bind('oc_1', 'segB', '/repo');

    const hits = await searchSession('codegraph', ctxFor({}, store));
    // 一个 OMP 会话 = 一个对话：两个会话 = 两行，不再合并计数。
    expect(hits).toHaveLength(2);
    expect(hits.map((h) => h.sessionId).sort()).toEqual(['segA', 'segB']);
    expect(hits.every((h) => h.groups.length === 1)).toBe(true);
    // 没名字时以最后一条用户消息作为身份。
    const topicById = Object.fromEntries(hits.map((h) => [h.sessionId, h.topic]));
    expect(topicById.segA).toBe('第一段 codegraph');
    expect(topicById.segB).toBe('第二段 codegraph');

    // 卡片：一行一个会话（`**#1**` / `**#2**` 普通字号行），只有卡片标题是 heading。
    const card = JSON.stringify(searchResultsCard('codegraph', hits, 'q1'));
    expect(card.match(/"text_size":"heading"/g)).toHaveLength(1);
    // 按最后活动倒序：较新的 segB 是 #1。
    expect(card).toContain('"content":"**#1** **第二段 codegraph**"');
    expect(card).toContain('"content":"**#2** **第一段 codegraph**"');
    expect(card).not.toContain('🧵');
    await store.flush();
  });

  it('shows an untitled session as its own single row (identity = the session id)', async () => {
    tmp = await mkdtemp(join(tmpdir(), 'search-test-'));
    paths.ompSessionsDir = tmp;
    await writeSession(tmp, 'orphan.jsonl', { id: 'orphan-1', cwd: '/repo', ts: '2026-08-15T10:00:00.000Z' }, [
      { role: 'user', ts: '2026-08-15T10:00:01.000Z', content: [{ type: 'text', text: 'codegraph 孤儿会话' }] },
    ]);

    const hits = await searchSession('codegraph', ctxFor());
    expect(hits).toHaveLength(1);
    expect(hits[0]!.sessionId).toBe('orphan-1');
    expect(hits[0]!.title).toBeUndefined();
    // No title → identity falls back to the session's own last user message.
    expect(hits[0]!.topic).toBe('codegraph 孤儿会话');
    expect(hits[0]!.groups).toHaveLength(1);
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
    expect(hits[0]!.groups).toHaveLength(1);
    // Representative is the newest matching pair inside the session.
    expect(hits[0]!.messages.map((m) => m.content)).toEqual([
      '第二处 codegraph 追问',
      '第二处 codegraph 回答',
    ]);
  });
});

describe('/search 卡片按钮链路', () => {
  /** Fake SDK surface for the managed-card path (cardkit create + im reply). */
  function cardCtx(over: Partial<CommandContext> = {}): { ctx: CommandContext; cards: string[] } {
    const cards: string[] = [];
    const rawClient = {
      cardkit: {
        v1: {
          card: {
            create: async (req: { data: { data: string } }) => {
              cards.push(req.data.data);
              return { data: { card_id: `card_${cards.length}` } };
            },
            update: async () => ({ data: {} }),
          },
        },
      },
      im: {
        v1: {
          message: {
            reply: async () => ({ data: { message_id: 'om_card' } }),
            create: async () => ({ data: { message_id: 'om_msg' } }),
            patch: async () => ({ data: {} }),
          },
        },
      },
    };
    return {
      cards,
      ctx: {
        scope: 'oc_1',
        msg: { chatId: 'oc_1', messageId: 'om_1', content: '' },
        chatMode: 'p2p',
        channel: { send: async () => {}, rawClient },
        workspaces: { cwdFor: () => undefined, setCwd: () => {}, listNamed: () => ({}), clearUndo: () => {} },
        sessions: { sessionFor: () => undefined, titleFor: () => undefined },
        activeRuns: { interrupt: () => false, has: () => false, register: () => true, unregister: () => {} },
        agent: {},
        controls: { cfg: {} },
        ...over,
      } as unknown as CommandContext,
    };
  }

  /** 8 sessions matching `kwhit`, newest first. */
  async function seed(dir: string): Promise<void> {
    for (let i = 0; i < 8; i++) {
      const hour = String(10 + i).padStart(2, '0');
      await writeSession(
        dir,
        `hit${i}.jsonl`,
        { id: `sess-hit-${i}`, cwd: `/repo/${i}`, ts: `2026-08-15T${hour}:00:00.000Z` },
        [{ role: 'user', ts: `2026-08-15T${hour}:00:01.000Z`, content: [{ type: 'text', text: `kwhit ${i}` }] }],
      );
    }
  }

  function queryIdOf(card: string): string {
    const qid = /"arg":"(s[a-z0-9]+) 1 \d+"/.exec(card)?.[1];
    expect(qid).toBeTruthy();
    return qid!;
  }

  it('结果上限大于卡片每页条数（否则分页永远不可达）', () => {
    expect(SEARCH_SESSION_LIMIT).toBeGreaterThan(SEARCH_PAGE_SIZE);
  });

  it('page 复用缓存按 offset 重发卡片，show 渲染详情卡', async () => {
    tmp = await mkdtemp(join(tmpdir(), 'search-test-'));
    paths.ompSessionsDir = tmp;
    await seed(tmp);

    const { ctx, cards } = cardCtx();
    await searchHandlers['/search']!('kwhit', ctx);
    expect(cards[0]).toContain('**#1**');
    const qid = queryIdOf(cards[0]!);

    cards.length = 0;
    await searchHandlers['/search']!(`page ${qid} 6`, { ...ctx, fromCardAction: true } as CommandContext);
    // 第二页：从 #7 起，页码区间跟着走。
    expect(cards[0]).toContain('**#7**');
    expect(cards[0]).toContain('第 7-8 个');
    expect(cards[0]).not.toContain('**#1**');

    // 从第 2 页点「详情」（详情载荷带全局行号 7 + 进入时的 offset 6）。
    cards.length = 0;
    await searchHandlers['/search']!(`show ${qid} 7 6`, { ...ctx, fromCardAction: true } as CommandContext);
    expect(cards[0]).toContain('搜索结果 #7');
    expect(cards[0]).toContain('继续对话');
    // 「返回结果」带同一个 offset —— 回到同一页（不是重发 /search 的第一页）。
    expect(cards[0]).toContain('返回结果');
    expect(cards[0]).toContain(`"arg":"${qid} 6"`);

    // 真的执行这条返回：又回到第 2 页（同一坐标）。
    cards.length = 0;
    await searchHandlers['/search']!(`page ${qid} 6`, { ...ctx, fromCardAction: true } as CommandContext);
    expect(cards[0]).toContain('**#7**');
    expect(cards[0]).toContain('第 7-8 个');
  });

  it('空态卡给出可执行动作：重新搜索回链到 search.do', async () => {
    tmp = await mkdtemp(join(tmpdir(), 'search-test-'));
    paths.ompSessionsDir = tmp;   // 空目录 → 没有任何命中

    const { ctx, cards } = cardCtx();
    await searchHandlers['/search']!('zzz-not-found', ctx);
    expect(cards[0]).toContain('没有找到包含');
    // 不是一个点不动的死胡同：真能执行的「重新搜索」。
    expect(cards[0]).toContain('重新搜索');
    expect(cards[0]).toContain('"cmd":"search.do"');
  });

  it('search.do <kw> 重跑同一次检索（与直接输入关键词同义）', async () => {
    tmp = await mkdtemp(join(tmpdir(), 'search-test-'));
    paths.ompSessionsDir = tmp;
    await seed(tmp);

    const { ctx, cards } = cardCtx();
    await searchHandlers['/search']!('do kwhit', ctx);
    expect(cards[0]).toContain('**#1**');
    expect(cards[0]).toContain('每页 6 条');
  });

  it('show 命中当前会话时带「⭐ 当前对话」且不给继续对话', async () => {
    tmp = await mkdtemp(join(tmpdir(), 'search-test-'));
    paths.ompSessionsDir = tmp;
    await seed(tmp);

    const { ctx, cards } = cardCtx();
    await searchHandlers['/search']!('kwhit', ctx);
    const qid = queryIdOf(cards[0]!);
    const newest = 'sess-hit-7';   // 最新的那条是 #1

    cards.length = 0;
    await searchHandlers['/search']!(`show ${qid} 1`, {
      ...ctx,
      fromCardAction: true,
      sessions: { sessionFor: () => ({ sessionId: newest, cwd: '/repo/7' }), titleFor: () => undefined },
    } as unknown as CommandContext);
    expect(cards[0]).toContain('⭐ 当前对话');
    expect(cards[0]).not.toContain('继续对话');
  });
});

describe('/search with an expired cache', () => {
  it('asks the user to re-search instead of resuming the current session', async () => {
    const ctx = {
      scope: 'oc_1',
      msg: { chatId: 'oc_1', messageId: 'om_1' },
      fromCardAction: true,
      channel: { send: async () => {} },
      sessions: { sessionFor: vi.fn() },
      controls: { cfg: {} },
    } as unknown as CommandContext;
    reply.mockClear();

    // The query id is not in the (module-level) cache — evicted or lost on restart.
    await searchHandlers['/search']!('show s-expired 1', ctx);

    expect(reply).toHaveBeenCalledTimes(1);
    expect(reply.mock.calls[0]![1]).toContain('过期');
    expect(reply.mock.calls[0]![1]).toContain('/search');
    // Never falls through to adopting the current chat session.
    expect(ctx.sessions.sessionFor).not.toHaveBeenCalled();
  });

  it('a 返回结果 / page button on an expired cache asks for a fresh search', async () => {
    const ctx = {
      scope: 'oc_1',
      msg: { chatId: 'oc_1', messageId: 'om_1' },
      fromCardAction: true,
      channel: { send: async () => {} },
      sessions: { sessionFor: vi.fn() },
      controls: { cfg: {} },
    } as unknown as CommandContext;
    reply.mockClear();

    await searchHandlers['/search']!('page s-expired 6', ctx);

    // 不再把「page s-expired 6」当关键词乱搜 —— 明确提示重新检索。
    expect(reply).toHaveBeenCalledTimes(1);
    expect(reply.mock.calls[0]![1]).toContain('过期');
    expect(reply.mock.calls[0]![1]).toContain('/search');
  });
});
