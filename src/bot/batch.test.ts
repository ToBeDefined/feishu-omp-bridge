import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { paths } from '../config/paths';
import type { LarkChannel } from '@larksuiteoapi/node-sdk';
import { streamCardPages } from './batch';
import type { AgentEvent } from '../agent/types';
import type { RunHandle } from './active-runs';
import type { SessionStore } from '../session/store';
import { countTables } from '../card/tables';

/** A 2-column GFM table tagged so tests can tell tables apart. */
function tableMd(n: number): string {
  return `| h${n} | v${n} |\n| --- | --- |\n| ${n} | ${n} |`;
}

/** Markdown of every element of a rendered card, panels included. */
function cardMarkdown(card: object): string[] {
  const elements = (card as { body?: { elements?: unknown[] } }).body?.elements ?? [];
  return elements.flatMap((e) => {
    if (typeof e !== 'object' || e === null) return [];
    const nested = 'elements' in e && Array.isArray(e.elements) ? e.elements : [];
    return [e, ...nested].flatMap((el) =>
      typeof el === 'object' && el !== null && 'content' in el && typeof el.content === 'string'
        ? [el.content]
        : [],
    );
  });
}

/** Fake channel whose `stream` records one page array per Feishu message. */
function fakeChannel(record: { cards: object[]; pages: object[][] }): LarkChannel {
  return {
    stream: async (
      _chatId: string,
      spec: { card: { initial: object; producer: (ctrl: { update(card: object): Promise<void> }) => Promise<void> } },
    ) => {
      const page: object[] = [spec.card.initial];
      record.pages.push(page);
      record.cards.push(spec.card.initial);
      await spec.card.producer({ update: async (card) => { record.cards.push(card); page.push(card); } });
    },
    send: async () => {},
  } as unknown as LarkChannel;
}

function fakeHandle(events: AgentEvent[]): RunHandle {
  return {
    run: {
      events: (async function* () {
        yield* events;
      })(),
      stop: async () => {},
      waitForExit: async () => true,
    },
    interrupted: false,
    pendingUiRequests: new Set<string>(),
    uiTimers: new Map<string, NodeJS.Timeout>(),
  } as unknown as RunHandle;
}

describe('streamCardPages', () => {
  it('paginates a table-heavy reply instead of letting Feishu reject it', async () => {
    // Production failure (2026-09-25): one answer with six markdown tables was
    // rejected with ErrCode 11310 "card table number over limit", which killed
    // the run and stranded the user on the "⚠️ 卡片渲染中断" fallback.
    const record = { cards: [] as object[], pages: [] as object[][] };
    const channel = fakeChannel(record);
    const events: AgentEvent[] = [
      { type: 'text', delta: Array.from({ length: 12 }, (_, i) => tableMd(i)).join('\n\n') },
      { type: 'done' },
    ];

    await streamCardPages(
      channel, 'oc_x', {}, fakeHandle(events), {} as unknown as SessionStore, 'oc_x', '/tmp',
      undefined, undefined, (s) => s,
    );

    expect(record.cards.length).toBeGreaterThan(1);
    for (const card of record.cards) {
      const tables = cardMarkdown(card).reduce((n, md) => n + countTables(md), 0);
      expect(tables).toBeLessThanOrEqual(5);
    }
    // Nothing is dropped AND nothing is demoted: every table reaches the user
    // as a real table component, on whichever page it landed.
    const realTables = new Set<string>();
    for (const md of record.cards.flatMap(cardMarkdown)) {
      const unfenced = md.replace(/```[\s\S]*?```/g, '');
      for (let i = 0; i < 12; i += 1) {
        if (unfenced.includes(`| h${i} | v${i} |`)) realTables.add(`h${i}`);
      }
    }
    // And nothing is repeated across messages: each table appears in exactly
    // one message's final card (drain pages must not re-render their carry).
    const finals = record.pages.map((page) => page.at(-1)!);
    const finalText = finals.flatMap(cardMarkdown).join('\n').replace(/```[\s\S]*?```/g, '');
    for (let i = 0; i < 12; i += 1) {
      expect(finalText.split(`| h${i} | v${i} |`).length - 1).toBe(1);
    }
    expect(realTables.size).toBe(12);
  });

  it('paginates a byte-heavy reply so no card crosses the 30KB Feishu cap', async () => {
    // Production failure (2026-09-29): a 36KB card was rejected with ErrCode
    // 200800 (Feishu caps cards at 30KB), killing the run on the fallback.
    // The page-closing push must carry only fitting content — it used to
    // re-send the full overflowing state.
    const record = { cards: [] as object[], pages: [] as object[][] };
    const channel = fakeChannel(record);
    const events: AgentEvent[] = [
      { type: 'text', delta: Array.from({ length: 40 }, (_, i) => `段落 ${i}\n` + '中'.repeat(700)).join('\n\n') },
      { type: 'done' },
    ];

    await streamCardPages(
      channel, 'oc_x', {}, fakeHandle(events), {} as unknown as SessionStore, 'oc_x', '/tmp',
      undefined, undefined, (s) => s,
    );

    expect(record.pages.length).toBeGreaterThan(1);
    for (const card of record.cards) {
      // 30KB is Feishu's hard cap; every card the channel saw must fit —
      // page initials, streaming updates, and closing cards alike.
      expect(Buffer.byteLength(JSON.stringify(card), 'utf8')).toBeLessThanOrEqual(30 * 1024);
    }
    // Nothing is dropped: all 40 paragraphs reach the user across messages.
    const finals = record.pages.map((page) => page.at(-1)!);
    const all = finals.flatMap(cardMarkdown).join('\n');
    for (let i = 0; i < 40; i += 1) {
      expect(all).toContain(`段落 ${i}`);
    }
    // …and nothing is repeated: each paragraph lands in exactly one message.
    // (A drain page must not re-render its carry as both the initial and the
    // final card, and a terminal event's own update must not be re-pushed by
    // the finalize path.)
    for (let i = 0; i < 40; i += 1) {
      expect(all.split(`段落 ${i}\n`).length - 1).toBe(1);
    }
  });
});

describe('产流中断的卡片收尾', () => {
  const origFile = paths.runningCardsFile;
  let dir: string;
  let file: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'stranded-'));
    file = join(dir, 'running-cards.json');
    paths.runningCardsFile = file;
  });
  afterEach(async () => {
    paths.runningCardsFile = origFile;
    await rm(dir, { recursive: true, force: true });
  });

  /** Channel whose card updates (and, per flag, the收尾 patch) are rejected. */
  function rejectingChannel(patched: object[], opts: { patchFails?: boolean } = {}): LarkChannel {
    return {
      stream: async (
        _chatId: string,
        spec: { card: { producer: (ctrl: { messageId: string; update(card: object): Promise<void> }) => Promise<void> } },
      ) => {
        await spec.card.producer({
          messageId: 'om_stranded',
          update: async () => {
            throw new Error('AxiosError: Request failed with status code 400');
          },
        });
      },
      send: async () => {},
      rawClient: {
        cardkit: { v1: { card: { create: async () => ({ data: { card_id: 'c_1' } }) } } },
        im: {
          v1: {
            message: {
              patch: async (req: { data: { content: string } }) => {
                if (opts.patchFails) throw new Error('AxiosError: Request failed with status code 400');
                patched.push(JSON.parse(req.data.content) as object);
              },
              create: async () => ({ data: { message_id: 'om_fallback' } }),
              reply: async () => ({ data: { message_id: 'om_fallback' } }),
            },
          },
        },
      },
    } as unknown as LarkChannel;
  }

  async function runFailingStream(channel: LarkChannel): Promise<void> {
    const events: AgentEvent[] = [{ type: 'text', delta: '正文内容' }, { type: 'done' }];
    await expect(
      streamCardPages(
        channel, 'oc_x', {}, fakeHandle(events), {} as unknown as SessionStore, 'oc_x', '/tmp',
        undefined, undefined, (s) => s,
      ),
    ).rejects.toThrow();
  }

  it('把停摆的卡补成终态（⏹ 消失），补上了就不必再留记录', async () => {
    const patched: object[] = [];
    await runFailingStream(rejectingChannel(patched));

    // 这张卡停在“运行中”的画面上：必须当场补成终态，用户才不会一直看着 ⏹。
    expect(patched.length).toBeGreaterThan(0);
    const stranded = JSON.stringify(patched[0]);
    expect(stranded).not.toContain('⏹');
    expect(stranded).not.toContain('"cmd":"stop"');
    expect(stranded).toContain('正文内容'); // 已产出的内容保住
    // 补上了 → 崩溃恢复记录可以撤（下次启动不必再管这张卡）。
    await vi.waitFor(async () => {
      const left = await readFile(file, 'utf8').then((t) => JSON.parse(t) as unknown[], () => []);
      expect(left).toEqual([]);
    });
  });

  it('收尾补卡也失败 → 留下记录，让下次启动的兜底再补', async () => {
    await runFailingStream(rejectingChannel([], { patchFails: true }));

    // 从前这里是 finally 里的无条件 forget：补卡失败一次，那个 ⏹ 就永远挂着了。
    await vi.waitFor(async () => {
      const left = JSON.parse(await readFile(file, 'utf8')) as Array<{ messageId: string }>;
      expect(left.map((c) => c.messageId)).toEqual(['om_stranded']);
    });
  });
});

describe('空流的卡片收尾', () => {
  it('一个事件都没来的页面也要补终态（否则 ⏹ 留在卡上永远不消失）', async () => {
    const record = { cards: [] as object[], pages: [] as object[][] };
    const channel = fakeChannel(record);

    // 事件流立刻结束（子进程秒退 / RPC 没帧）：从来没有任何 agent 事件。
    await streamCardPages(
      channel, 'oc_x', {}, fakeHandle([]), {} as unknown as SessionStore, 'oc_x', '/tmp',
      undefined, undefined, (s) => s,
    );

    // 第一张卡是运行态（带 ⏹）；必须还有一张终态卡把它补掉。
    expect(JSON.stringify(record.pages[0]![0])).toContain('⏹');
    const last = record.pages.at(-1)!.at(-1)!;
    expect(JSON.stringify(last)).not.toContain('⏹');
    expect(JSON.stringify(last)).not.toContain('"cmd":"stop"');
  });
});
