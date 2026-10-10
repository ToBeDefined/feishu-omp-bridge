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

describe('/new — 开新对话', () => {
  it('starts a new conversation: the active pointer is cleared, the old one stays', async () => {
    store.bindSegment('oc_1', 'sess-a', root);
    store.setTitle('oc_1', '修搜索');
    const spy = vi.spyOn(store, 'startWorkSession');
    const { ctx } = makeCtx();

    await handleNew('', ctx);

    expect(spy).toHaveBeenCalledWith('oc_1');
    // 下一条消息新建 OMP 会话 = 新的一摊：当前对话被摘掉。
    expect(store.activeWorkSession('oc_1')).toBeUndefined();
    // 旧对话连同它的名字原样留在 store 里。
    expect(store.workSessionById('sess-a')?.title).toBe('修搜索');
    expect(store.titleFor('sess-a')).toBe('修搜索');
  });

  it('keeps the old conversation in the store after /new', async () => {
    store.bindSegment('oc_1', 'sess-a', root);
    store.setTitle('oc_1', '修搜索');
    const { ctx } = makeCtx();

    await handleNew('', ctx);

    // 旧对话没被删：/history 里仍能看到它，名字也还在。
    expect(store.allWorkSessions().map((ws) => ws.id)).toContain('sess-a');
    expect(store.titleFor('sess-a')).toBe('修搜索');
    // 但当前对话已不是它 —— 下一条消息开新的。
    expect(store.activeWorkSession('oc_1')).toBeUndefined();
  });

  it('binds the next message into a NEW, unnamed conversation', async () => {
    store.bindSegment('oc_1', 'sess-a', root);
    store.setTitle('oc_1', '修搜索');
    const { ctx } = makeCtx();

    await handleNew('', ctx);
    store.bindSegment('oc_1', 'sess-next', root);

    const ws = store.activeWorkSession('oc_1');
    // 新对话 = 新的一摊，名字从无名开始。
    expect(ws?.id).toBe('sess-next');
    expect(ws?.title).toBeUndefined();
    // 旧对话的名字不会被新对话继承。
    expect(store.workSessionById('sess-a')?.title).toBe('修搜索');
    expect(store.titleFor('sess-a')).toBe('修搜索');
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
  it('says the context was reset, without the old conversation name', async () => {
    store.bindSegment('oc_1', 'sess-a', root);
    store.setTitle('oc_1', 'KMP 导出');
    const { ctx, sent } = makeCtx();

    await handleNew('', ctx);

    const json = cardJson(sent);
    expect(json).toContain('上下文已重置');
    // 新对话刚开、还没名字：不再顶着旧对话的名字。
    expect(json).not.toContain('KMP 导出');
    expect(json).not.toContain('仍在同一工作会话');
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

  it('does not surface a stale name from history (fresh conversation is unnamed)', async () => {
    store.bindSegment('oc_1', 'sess-a', root);
    const { ctx, sent } = makeCtx();
    // 旧的 OMP 会话文件里有消息，但 /new 之后当前对话是新的、未命名的。
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

    expect(cardJson(sent)).toContain('上下文已重置');
    expect(cardJson(sent)).not.toContain('看一下 KMP 的导出');
  });
});
