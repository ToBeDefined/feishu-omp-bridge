import { mkdtemp, rm, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { paths } from '../../config/paths';
import type { CommandContext } from '../index';
import { handleHistory } from './history';
import { listSessions } from './sessions';

const { reply, recallMessage, sendManagedCard } = vi.hoisted(() => ({
  reply: vi.fn(async (_ctx: unknown, _text: string) => {}),
  recallMessage: vi.fn(async (_ctx: unknown) => {}),
  sendManagedCard: vi.fn(async (_channel: unknown, _chatId: string, _card: unknown) => ({
    messageId: 'om_card',
  })),
}));

vi.mock('../shared', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../shared')>();
  return { ...actual, reply, recallMessage };
});
vi.mock('../../card/managed', () => ({ sendManagedCard }));

const origDir = paths.ompSessionsDir;
let tmp: string;

beforeEach(async () => {
  tmp = await mkdtemp(join(tmpdir(), 'history-'));
  paths.ompSessionsDir = tmp;
  reply.mockClear();
  sendManagedCard.mockClear();
  recallMessage.mockClear();
});

afterEach(async () => {
  paths.ompSessionsDir = origDir;
  await rm(tmp, { recursive: true, force: true });
});

/** One session file: header + `turns` real user turns + an assistant reply. */
async function writeSession(
  name: string,
  session: { id: string; cwd: string; ts: string },
  turns: number,
  timeMs: number,
): Promise<void> {
  const lines = [
    JSON.stringify({ type: 'session', id: session.id, cwd: session.cwd, timestamp: session.ts }),
  ];
  for (let i = 0; i < turns; i += 1) {
    lines.push(
      JSON.stringify({
        type: 'message',
        timestamp: `t${i}`,
        message: { role: 'user', content: [{ type: 'text', text: `问题 ${i}` }] },
      }),
      JSON.stringify({
        type: 'message',
        timestamp: `a${i}`,
        message: { role: 'assistant', content: [{ type: 'text', text: `回答 ${i}` }] },
      }),
    );
  }
  const file = join(tmp, name);
  await writeFile(file, `${lines.join('\n')}\n`, 'utf8');
  const secs = timeMs / 1000;
  await utimes(file, secs, secs);
}

function makeCtx(over: Partial<Record<string, unknown>> = {}): CommandContext {
  return {
    scope: 'oc_1',
    workspaces: {
      cwdFor: () => '/repo/a',
      listNamed: () => ({ bridge: '/repo/a' }),
    },
    sessions: { titlesBySessionId: () => ({ s1: '命名的会话' }) },
    controls: { cfg: {} },
    channel: { send: async () => {} },
    msg: { chatId: 'oc_1', messageId: 'om_1' },
    fromCardAction: false,
    ...over,
  } as unknown as CommandContext;
}

/** The card the handler just handed to the managed-card API. */
interface CardShape {
  body: { elements: Array<Record<string, unknown>> };
}

function sentCard(): CardShape {
  expect(sendManagedCard).toHaveBeenCalledTimes(1);
  return sendManagedCard.mock.calls[0]![2] as CardShape;
}

function cardJson(): string {
  return JSON.stringify(sentCard());
}

describe('listSessions', () => {
  it('reads every session, counts real turns, and sorts by activity', async () => {
    await writeSession('a.jsonl', { id: 's1', cwd: '/repo/a', ts: '2026-01-01T00:00:00Z' }, 3, Date.now() - 7_200_000);
    await writeSession('b.jsonl', { id: 's2', cwd: '/repo/b', ts: '2026-02-01T00:00:00Z' }, 1, Date.now() - 60_000);
    // Header without id/cwd is skipped rather than failing the whole listing.
    await writeFile(join(tmp, 'broken.jsonl'), '{"type":"session"}\n', 'utf8');
    await writeFile(join(tmp, 'notes.txt'), 'ignored', 'utf8');

    const sessions = await listSessions(makeCtx());
    expect(sessions.map((s) => s.sessionId)).toEqual(['s2', 's1']);
    expect(sessions.find((s) => s.sessionId === 's1')).toMatchObject({
      cwd: '/repo/a',
      turns: 3,
      startedAt: '2026-01-01T00:00:00Z',
      title: '命名的会话',
      summary: '回答 2',
      lastMessage: '问题 2',
    });
  });
});

describe('/history', () => {
  beforeEach(async () => {
    // /repo/a (current workspace): two conversations, the newer one most recent.
    await writeSession('a1.jsonl', { id: 's1', cwd: '/repo/a', ts: '2026-01-01T00:00:00Z' }, 3, Date.now() - 7_200_000);
    await writeSession('a2.jsonl', { id: 's3', cwd: '/repo/a', ts: '2026-01-02T00:00:00Z' }, 5, Date.now() - 120_000);
    // Another workspace: must NOT show up in the scoped listing.
    await writeSession('b1.jsonl', { id: 's2', cwd: '/repo/b', ts: '2026-01-03T00:00:00Z' }, 1, Date.now() - 60_000);
  });

  it('lists only the current workspace, newest activity first', async () => {
    await handleHistory('', makeCtx());
    const card = cardJson();
    expect(card).toContain('`/repo/a` · 2 个会话');
    expect(card).toContain('💬 5 轮');
    expect(card).toContain('💬 3 轮');
    // Newer activity (#1 = s3) leads, and an unnamed session is identified by
    // its last real user message.
    expect(card.indexOf('#1')).toBeLessThan(card.indexOf('#2'));
    expect(card.slice(card.indexOf('#1'))).toContain('问题 4');
    // The titled row keeps the title AND still shows its topic.
    expect(card).toContain('🏷 **命名的会话**');
    expect(card).toContain('问题 2');
    // The other workspace's session is filtered out.
    expect(card).not.toContain('问题 0');
    // Rows do not repeat the header's directory.
    expect(card).not.toContain('📁');
    expect(sendManagedCard).toHaveBeenCalledWith(
      expect.anything(),
      'oc_1',
      expect.anything(),
    );
  });

  it('lists every workspace with /history all, labelled per row', async () => {
    await handleHistory('all', makeCtx());
    const card = cardJson();
    expect(card).toContain('全部工作区 · 3 个会话');
    expect(card).toContain('📁 bridge');
    expect(card).toContain('📁 /repo/b');
    expect(card).toContain('问题 0');
  });

  it('honours the pager payload (`page <mode> <offset>`)', async () => {
    await handleHistory('page all 8', makeCtx());
    // 9th row onwards already rendered on the previous page; the PAGER is
    // exercised end-to-end by /history all paging past the page size.
    expect(cardJson()).toContain('全部工作区 · 3 个会话');
  });

  it('clamps a stale offset instead of rendering an empty page', async () => {
    await handleHistory('all 99', makeCtx());
    expect(cardJson()).toContain('问题 0');
  });

  it('rejects unknown arguments with usage', async () => {
    await handleHistory('yesterday', makeCtx());
    expect(sendManagedCard).not.toHaveBeenCalled();
    expect(reply.mock.calls[0]![1]).toContain('`/history all`');
  });

  it('says so when the workspace has no history yet', async () => {
    const ctx = makeCtx({
      workspaces: { cwdFor: () => '/repo/empty', listNamed: () => ({}) },
    });
    await handleHistory('', ctx);
    expect(sendManagedCard).not.toHaveBeenCalled();
    expect(reply.mock.calls[0]![1]).toContain('/repo/empty');
    expect(reply.mock.calls[0]![1]).toContain('/history all');
  });

  it('replaces the clicked card instead of stacking a new one', async () => {
    await handleHistory('all 8', makeCtx({ fromCardAction: true }));
    expect(recallMessage).toHaveBeenCalled();
  });
});
