import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Mock } from 'vitest';
import type { CommandContext } from '../index';
import { WorkSessionStore } from '../../session/work-store';
import { newHandlers } from './new';

const handleNew = newHandlers['/new']!;

let root: string;
let store: WorkSessionStore;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'new-test-'));
  store = new WorkSessionStore(join(root, 'sessions.json'));
  await store.load();
});

afterEach(async () => {
  await store.flush();
  await rm(root, { recursive: true, force: true });
});

function makeCtx(over: { wasRunning?: boolean } = {}): {
  ctx: CommandContext;
  interrupt: Mock;
  clearUndo: Mock;
  sent: unknown[];
} {
  const interrupt = vi.fn().mockReturnValue(over.wasRunning ?? false);
  const clearUndo = vi.fn();
  const sent: unknown[] = [];
  const ctx = {
    channel: {
      send: async (_chatId: string, payload: { card?: object; markdown?: string }) => {
        sent.push(payload.card ?? payload.markdown);
      },
    } as never,
    msg: {
      chatId: 'oc_1',
      messageId: 'om_1',
      content: '',
      senderId: 'ou_1',
    } as never,
    scope: 'oc_1',
    chatMode: 'p2p',
    workSessions: store,
    workspaces: { cwdFor: () => root, clearUndo } as never,
    agent: {} as never,
    activeRuns: { interrupt } as never,
    // 空的 OMP 会话目录：无名工作会话的“最后一条用户消息”回退拿不到 → 不显示。
    controls: { cfg: { preferences: { ompSessionDir: join(root, 'omp') } } } as never,
  } as CommandContext;
  return { ctx, interrupt, clearUndo, sent };
}

const cardJson = (sent: unknown[]): string => JSON.stringify(sent[0]);

describe('/new — 只重置上下文', () => {
  it('keeps the SAME work session, drops only the current segment', async () => {
    store.bindSegment('oc_1', 'sess-a', root);
    store.bindSegment('oc_1', 'sess-b', root);
    const before = store.activeWorkSession('oc_1');
    const { ctx } = makeCtx();

    await handleNew('', ctx);

    const after = store.activeWorkSession('oc_1');
    // 同一个工作会话，id 不变。
    expect(after?.id).toBe(before?.id);
    expect(after?.id).toBe('sess-a');
    // 段没丢，只是没有“当前段”了。
    expect(after?.segments.map((s) => s.sessionId)).toEqual(['sess-a', 'sess-b']);
    expect(after?.currentSegmentId).toBeUndefined();
  });

  it('does NOT start a new work session', async () => {
    store.bindSegment('oc_1', 'sess-a', root);
    store.setTitle('oc_1', '修搜索');
    const { ctx } = makeCtx();

    await handleNew('', ctx);

    // 工作会话总数不变（没有 /work 那样的归档 + 新建）。
    expect(store.allWorkSessions()).toHaveLength(1);
    expect(store.activeWorkSession('oc_1')?.title).toBe('修搜索');
  });

  it('binds the next segment into the SAME work session, inheriting its title', async () => {
    store.bindSegment('oc_1', 'sess-a', root);
    store.setTitle('oc_1', '修搜索');
    const { ctx } = makeCtx();

    await handleNew('', ctx);
    store.bindSegment('oc_1', 'sess-next', root);

    const ws = store.activeWorkSession('oc_1');
    expect(ws?.id).toBe('sess-a');
    expect(ws?.segments.map((s) => s.sessionId)).toEqual(['sess-a', 'sess-next']);
    expect(ws?.currentSegmentId).toBe('sess-next');
    // 同一工作会话的新一段继承名字。
    expect(ws?.title).toBe('修搜索');
  });

  it('interrupts the running task', async () => {
    store.bindSegment('oc_1', 'sess-a', root);
    const { ctx, interrupt } = makeCtx({ wasRunning: true });

    await handleNew('', ctx);

    expect(interrupt).toHaveBeenCalledWith('oc_1');
  });

  it('clears the pending /ws undo', async () => {
    const { ctx, clearUndo } = makeCtx();
    await handleNew('', ctx);
    expect(clearUndo).toHaveBeenCalledWith('oc_1');
  });
});

describe('/new — 卡片文案', () => {
  it('shows the work session name and says the context was reset', async () => {
    store.bindSegment('oc_1', 'sess-a', root);
    store.setTitle('oc_1', 'KMP 导出');
    const { ctx, sent } = makeCtx();

    await handleNew('', ctx);

    const json = cardJson(sent);
    expect(json).toContain('上下文已重置');
    expect(json).toContain('KMP 导出');
    expect(json).toContain('仍在同一工作会话');
    // 不再是“开始新会话”的说法。
    expect(json).not.toContain('已开始新会话');
  });

  it('renders no name placeholder when the work session is unnamed', async () => {
    store.bindSegment('oc_1', 'sess-a', root);
    const { ctx, sent } = makeCtx();

    await handleNew('', ctx);

    const json = cardJson(sent);
    expect(json).toContain('上下文已重置');
    expect(json).not.toContain('未命名');
    expect(json).not.toContain('🧵');
  });

  it('falls back to the last user message when there is no title', async () => {
    store.bindSegment('oc_1', 'sess-a', root);
    const { ctx, sent } = makeCtx();
    // 让 OMP 会话目录里有一份该段的 JSONL，最后一条用户消息作为回退名字。
    const dir = join(root, 'omp');
    await mkdir(dir, { recursive: true });
    await writeFile(
      join(dir, 'sess-a.jsonl'),
      [
        JSON.stringify({ type: 'session', id: 'sess-a', cwd: root, timestamp: 't0' }),
        JSON.stringify({
          type: 'message',
          message: {
            role: 'user',
            content: [{ type: 'text', text: '看一下 KMP 的导出' }],
          },
        }),
      ].join('\n'),
      'utf8',
    );

    await handleNew('', ctx);

    expect(cardJson(sent)).toContain('看一下 KMP 的导出');
  });
});
