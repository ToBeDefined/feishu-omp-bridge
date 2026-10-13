import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { paths } from '../config/paths';
import type { LarkChannel } from '@larksuiteoapi/node-sdk';
import {
  createUiHooks,
  sendTextPages,
  streamCardPages,
  TEXT_MESSAGE_BUDGET,
  type AgentStreamHooks,
} from './batch';
import type { ActiveRuns, RunHandle } from './active-runs';
import type { AgentEvent, AgentUiRequest } from '../agent/types';
import type { SessionStore } from '../session/store';
import { runningCardsSettled } from '../card/managed';
import { countTables } from '../card/tables';
import { initialState, reduce, type RunState } from '../card/run-state';
import type { RunCard } from '../card/run-renderer';
import { renderText } from '../card/text-renderer';

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

function fakeHandle(events: AgentEvent[] | AsyncIterable<AgentEvent>): RunHandle {
  const source = Array.isArray(events)
    ? (async function* () {
        yield* events;
      })()
    : events;
  return {
    run: {
      events: source,
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
    await runningCardsSettled();
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
    await streamCardPages(
      channel, 'oc_x', {}, fakeHandle(events), {} as unknown as SessionStore, 'oc_x', '/tmp',
      undefined, undefined, (s) => s,
    );
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

    // 写入走 managed 的串行链且是 fire-and-forget：等链排空后断言一次即可，
    // 与机器负载无关（vi.waitFor 固定 1s 超时在满载下会误报）。
    await runningCardsSettled();

    const left = JSON.parse(await readFile(file, 'utf8')) as Array<{ messageId: string }>;
    expect(left.map((c) => c.messageId)).toEqual(['om_stranded']);
  });
});

describe('分页关闭时 patch 未落地（SDK 的 patch 是异步的）', () => {
  const origFile = paths.runningCardsFile;
  let dir: string;
  let file: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'close-fail-'));
    file = join(dir, 'running-cards.json');
    paths.runningCardsFile = file;
  });
  afterEach(async () => {
    await runningCardsSettled();
    paths.runningCardsFile = origFile;
    await rm(dir, { recursive: true, force: true });
  });

  /**
   * 复刻 SDK 的 CardStreamControllerImpl：`ctrl.update()` 只把卡片记下来、让真正的
   * im.message.patch 走节流定时器，**立刻 resolve**；patch 直到流收尾
   * （收尾失败时 stream 抛错，生产代码会将其降级为已完成而不再 rethrow。）
   */
  function deferredPatchChannel(failIds: Set<string>): {
    channel: LarkChannel;
    messageIds: string[];
    patched: object[];
  } {
    const messageIds: string[] = [];
    const patched: object[] = [];
    const patch = async (messageId: string, card: object): Promise<void> => {
      if (failIds.has(messageId)) throw new Error('AxiosError: Request failed with status code 400');
      patched.push(card);
    };
    const channel = {
      stream: async (
        _chatId: string,
        spec: {
          card: {
            initial: object;
            producer: (ctrl: { messageId: string; update(card: object): Promise<void> }) => Promise<void>;
          };
        },
      ) => {
        const messageId = `om_page${messageIds.length}`;
        messageIds.push(messageId);
        let last = spec.card.initial;
        await spec.card.producer({
          messageId,
          update: async (card) => {
            last = card; // 与 SDK 一样：只是记下，不等 patch 落地
          },
        });
        await patch(messageId, last); // 收尾：这一页的最后一张画面
      },
      send: async () => {},
      rawClient: {
        cardkit: { v1: { card: { create: async () => ({ data: { card_id: 'c_1' } }) } } },
        im: {
          v1: {
            message: {
              patch: async (req: { path: { message_id: string }; data: { content: string } }) =>
                patch(req.path.message_id, JSON.parse(req.data.content) as object),
              create: async () => ({ data: { message_id: 'om_fallback' } }),
              reply: async () => ({ data: { message_id: 'om_fallback' } }),
            },
          },
        },
      },
    };
    return { channel: channel as unknown as LarkChannel, messageIds, patched };
  }

  /** 12 张表让第一页必然在表格预算处收尾（换页），即「一页关闭」。 */
  const overflowingEvents: AgentEvent[] = [
    { type: 'text', delta: Array.from({ length: 12 }, (_, i) => tableMd(i)).join('\n\n') },
    { type: 'done' },
  ];

  async function leftovers(): Promise<Array<{ messageId: string }>> {
    return JSON.parse(await readFile(file, 'utf8').catch(() => '[]')) as Array<{ messageId: string }>;
  }

  it('一页关闭的 patch 被拒 → 这张卡的登记留着（否则卡停在运行态且无人认领）', async () => {
    // 修复前：producer 的 finally 无条件 forgetStreamingCard，等 stream() 把收尾
    // patch 的失败抛出来时，登记已经没了 —— 卡上的 ⏹ 永远挂着（线上事故形态）。
    const { channel, messageIds } = deferredPatchChannel(new Set(['om_page0']));

    await streamCardPages(
      channel, 'oc_x', {}, fakeHandle(overflowingEvents), {} as unknown as SessionStore, 'oc_x', '/tmp',
      undefined, undefined, (s) => s,
    );

    expect(messageIds).toContain('om_page0');
    await runningCardsSettled();
    expect((await leftovers()).map((c) => c.messageId)).toContain('om_page0');
  });

  it('每页的 patch 都确认落地才撤登记：分页正常跑完 running-cards 为空', async () => {
    const { channel, messageIds, patched } = deferredPatchChannel(new Set());

    await streamCardPages(
      channel, 'oc_x', {}, fakeHandle(overflowingEvents), {} as unknown as SessionStore, 'oc_x', '/tmp',
      undefined, undefined, (s) => s,
    );
    await runningCardsSettled();

    expect(messageIds.length).toBeGreaterThan(1); // 确实分页了
    expect(patched.length).toBeGreaterThan(0);
    // 确认成功 → 登记全撤（既不留死记录，也不给已完成的卡补「进程中断」）。
    expect(await leftovers()).toEqual([]);
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

describe('心跳：事件流静默期间卡片继续走动', () => {
  /** 控制行（标题之后的第一个元素）的 JSON —— 「用时」就写在里面。 */
  const controlRow = (card: object): string => {
    // 这里的 card 都是 renderCard 的产物（fakeChannel 只记录被推出去的卡）。
    // 运行态的「状态 + ⏹」在卡片**末尾**的底部控制区里。
    const rendered = card as RunCard;
    const blocks = rendered.body.elements.filter((e) => JSON.stringify(e).includes('"cmd":"stop"'));
    return JSON.stringify(blocks.at(-1) ?? {});
  };

  it('没有新事件也会按时 patch，run 终结后定时器彻底停掉', async () => {
    vi.useFakeTimers();
    try {
      const record = { cards: [] as object[], pages: [] as object[][] };
      const channel = fakeChannel(record);
      let release!: () => void;
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      // 一条 text 之后流彻底静默（一次长工具调用），直到测试放行才 done。
      const handle = fakeHandle(
        (async function* () {
          yield { type: 'text', delta: '正文' } as AgentEvent;
          await gate;
          yield { type: 'done' } as AgentEvent;
        })(),
      );

      const run = streamCardPages(
        channel, 'oc_x', {}, handle, {} as unknown as SessionStore, 'oc_x', '/tmp',
        undefined, undefined, (s) => s,
      );

      await vi.advanceTimersByTimeAsync(500);
      const afterFirstEvent = record.cards.length;
      expect(afterFirstEvent).toBeGreaterThanOrEqual(2); // initial + 事件 patch
      const before = controlRow(record.cards.at(-1)!);
      expect(before).toContain('⏱ ');

      // 静默 5s：没有任何 agent 事件，心跳仍推了一张新卡，时长跟着走。
      await vi.advanceTimersByTimeAsync(5000);
      expect(record.cards.length).toBeGreaterThan(afterFirstEvent);
      const after = controlRow(record.cards.at(-1)!);
      expect(after).not.toBe(before);
      expect(after).toContain('⏱ 5');

      release();
      await vi.advanceTimersByTimeAsync(1000);
      await run;
      const atEnd = record.cards.length;

      // 终态之后再等三个心跳周期：一次 patch 都不能有（定时器已清干净）。
      await vi.advanceTimersByTimeAsync(15_000);
      expect(record.cards.length).toBe(atEnd);
      // 直接证明没有泄漏的定时器（心跳 interval 是这张卡唯一的定时器）。
      expect(vi.getTimerCount()).toBe(0);
      expect(controlRow(record.cards.at(-1)!)).not.toContain('⏹');
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('文本回退的分段发送', () => {
  function recordingChannel(sent: string[]): LarkChannel {
    return {
      send: async (_chatId: string, msg: { markdown: string }) => {
        sent.push(msg.markdown);
      },
    } as unknown as LarkChannel;
  }

  it('超长文本按预算分段发送，失败原因留在其中一条里', async () => {
    const sent: string[] = [];
    let state: RunState = reduce(initialState, {
      type: 'text',
      delta: '正文'.repeat(5000),
    } as AgentEvent);
    state = { ...state, terminal: 'error', errorMsg: 'boom：模型不可用' };
    const body = renderText(state);

    await sendTextPages(recordingChannel(sent), 'oc_x', {}, body);

    expect(sent.length).toBeGreaterThan(1);
    for (const message of sent) {
      expect(Buffer.byteLength(message, 'utf8')).toBeLessThanOrEqual(TEXT_MESSAGE_BUDGET);
    }
    // 分段不丢内容（拼回去与原文本一致），失败原因没有被截在段外。
    expect(sent.join('')).toBe(body);
    expect(sent.some((message) => message.includes('boom：模型不可用'))).toBe(true);
  });

  it('短文本只发一条', async () => {
    const sent: string[] = [];
    await sendTextPages(recordingChannel(sent), 'oc_x', {}, '你好');
    expect(sent).toEqual(['你好']);
  });
});

describe('OMP 交互卡发送失败', () => {
  /** 卡片发送直接失败的 channel（cardkit.card.create 抛出）。 */
  function failingCardChannel(notices: string[]): LarkChannel {
    return {
      rawClient: {
        cardkit: {
          v1: {
            card: {
              create: async () => {
                throw new Error('AxiosError: Request failed with status code 500');
              },
            },
          },
        },
      },
      send: async (_chatId: string, msg: { markdown: string }) => {
        notices.push(msg.markdown);
      },
    } as unknown as LarkChannel;
  }

  function hooksFor(
    channel: LarkChannel,
    recorded: { responded: Array<{ id: string; response: unknown }>; dropped: string[] },
  ): AgentStreamHooks {
    return createUiHooks({
      channel,
      chatId: 'oc_x',
      scope: 'oc_x',
      replyToMessageId: 'om_user',
      activeRuns: {
        respondToUi: (_scope: string, id: string, response: unknown) => {
          recorded.responded.push({ id, response });
          return true;
        },
        dropUiRequest: (_scope: string, id: string) => {
          recorded.dropped.push(id);
        },
      } as unknown as ActiveRuns,
      cards: new Map(),
    });
  }

  const request: AgentUiRequest = {
    id: 'ui-1',
    method: 'confirm',
    title: '要删掉这个文件吗',
    message: 'rm -rf build',
  };

  it('既回 {cancelled:true} 给 OMP（别让它挂着），也给用户一条可见提示', async () => {
    const notices: string[] = [];
    const recorded = { responded: [] as Array<{ id: string; response: unknown }>, dropped: [] as string[] };
    const hooks = hooksFor(failingCardChannel(notices), recorded);

    await hooks.onUiRequest(request);

    // OMP 侧必须收到回包，否则这次 run 永远等一个不可能到来的答案。
    expect(recorded.responded).toEqual([{ id: 'ui-1', response: { cancelled: true } }]);
    expect(recorded.dropped).toEqual(['ui-1']);
    // 用户侧不再静默：为什么没有确认框、以及已经按取消处理。
    expect(notices).toHaveLength(1);
    expect(notices[0]).toContain('⚠️ 交互卡片发送失败，已按取消处理');
  });

  it('提示本身也发不出去时不抛（网络正是卡片失败的原因）', async () => {
    const recorded = { responded: [] as Array<{ id: string; response: unknown }>, dropped: [] as string[] };
    const channel = {
      rawClient: {
        cardkit: {
          v1: {
            card: {
              create: async () => {
                throw new Error('offline');
              },
            },
          },
        },
      },
      send: async () => {
        throw new Error('offline');
      },
    } as unknown as LarkChannel;

    await expect(hooksFor(channel, recorded).onUiRequest(request)).resolves.toBeUndefined();
    expect(recorded.responded).toHaveLength(1);
  });
});

describe('OMP 交互卡倒计时', () => {
  /** 卡片所有 markdown 元素的正文（用于断言「剩余 N 秒」）。 */
  const cardText = (card: object): string => {
    const elements = (card as { body?: { elements?: unknown[] } }).body?.elements ?? [];
    const parts: string[] = [];
    for (const el of elements) {
      if (typeof el === 'object' && el !== null && 'content' in el) {
        const content: unknown = el.content;
        if (typeof content === 'string') parts.push(content);
      }
    }
    return parts.join('\n');
  };

  /** CardKit fake：create/reply 发一张卡，update 记录每次重渲染的卡。 */
  function uiChannel(record: { cards: object[] }): LarkChannel {
    let seq = 0;
    return {
      send: async () => {},
      rawClient: {
        cardkit: {
          v1: {
            card: {
              create: async (req: { data: { data: string } }) => {
                record.cards.push(JSON.parse(req.data.data) as object);
                return { data: { card_id: `c_${++seq}` } };
              },
              update: async (req: { data: { card: { data: string } } }) => {
                record.cards.push(JSON.parse(req.data.card.data) as object);
              },
            },
          },
        },
        im: {
          v1: {
            message: {
              create: async () => ({ data: { message_id: 'om_ui' } }),
              reply: async () => ({ data: { message_id: 'om_ui' } }),
            },
          },
        },
      },
    } as unknown as LarkChannel;
  }

  /**
   * active-runs 的定时器语义复刻：倒计时续期、respondToUi 清定时器、dropUiRequest
   * 清定时器 —— 倒计时链只经手这一个定时器，所以这里就是「唯一时钟」的替身。
   */
  function fakeActiveRuns(
    pending: Set<string>,
    responded: Array<{ id: string; response: unknown }>,
  ): ActiveRuns {
    const timers = new Map<string, NodeJS.Timeout>();
    const clear = (id: string): void => {
      const t = timers.get(id);
      if (t) {
        clearTimeout(t);
        timers.delete(id);
      }
    };
    return {
      armUiTimeout: (_scope: string, id: string, ms: number, cb: () => void): boolean => {
        clear(id);
        timers.set(id, setTimeout(() => { timers.delete(id); cb(); }, ms));
        return true;
      },
      respondToUi: (_scope: string, id: string, response: unknown): boolean => {
        if (!pending.has(id)) return false;
        clear(id);
        pending.delete(id);
        responded.push({ id, response });
        return true;
      },
      dropUiRequest: (_scope: string, id: string): void => {
        clear(id);
        pending.delete(id);
      },
    } as unknown as ActiveRuns;
  }

  function hooksWith(
    channel: LarkChannel,
    activeRuns: ActiveRuns,
    pending: Set<string>,
  ): { hooks: AgentStreamHooks; cards: Map<string, { messageId: string; title: string; deadline?: number }> } {
    const cards = new Map<string, { messageId: string; title: string; deadline?: number }>();
    const hooks = createUiHooks({
      channel,
      chatId: 'oc_x',
      scope: 'oc_x',
      replyToMessageId: 'om_user',
      activeRuns,
      cards,
      isPending: (id) => pending.has(id),
    });
    return { hooks, cards };
  }

  const confirmRequest: AgentUiRequest = {
    id: 'ui-1',
    method: 'confirm',
    title: '确认继续',
    message: '继续？',
    timeout: 12_000,
  };

  it('推进假时钟后重渲染剩余秒数；到 0 走超时路径且不再有后续 patch', async () => {
    vi.useFakeTimers();
    try {
      const record = { cards: [] as object[] };
      const pending = new Set<string>(['ui-1']);
      const responded: Array<{ id: string; response: unknown }> = [];
      const activeRuns = fakeActiveRuns(pending, responded);
      const { hooks, cards } = hooksWith(uiChannel(record), activeRuns, pending);

      await hooks.onUiRequest(confirmRequest);
      expect(cardText(record.cards.at(-1)!)).toContain('剩余 12 秒');

      await vi.advanceTimersByTimeAsync(5000);
      expect(cardText(record.cards.at(-1)!)).toContain('剩余 7 秒');

      await vi.advanceTimersByTimeAsync(5000);
      expect(cardText(record.cards.at(-1)!)).toContain('剩余 2 秒');

      // 到点：回包 cancelled（沿用既有超时行为）+ 卡片终态。
      await vi.advanceTimersByTimeAsync(2500);
      expect(responded).toEqual([{ id: 'ui-1', response: { cancelled: true, timedOut: true } }]);
      expect(cardText(record.cards.at(-1)!)).toContain('已超时');
      expect(cards.has('ui-1')).toBe(false);

      // 之后再也没有 patch：定时器彻底清光。
      const atEnd = record.cards.length;
      await vi.advanceTimersByTimeAsync(60_000);
      expect(record.cards.length).toBe(atEnd);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('用户回包后倒计时彻底停掉（定时器被 respondToUi 清掉）', async () => {
    vi.useFakeTimers();
    try {
      const record = { cards: [] as object[] };
      const pending = new Set<string>(['ui-1']);
      const responded: Array<{ id: string; response: unknown }> = [];
      const activeRuns = fakeActiveRuns(pending, responded);
      const { hooks } = hooksWith(uiChannel(record), activeRuns, pending);

      await hooks.onUiRequest(confirmRequest);
      await vi.advanceTimersByTimeAsync(5000);
      const before = record.cards.length;

      // 用户点了「确认」：active-runs 清掉倒计时定时器，请求不再 pending。
      expect(activeRuns.respondToUi('oc_x', 'ui-1', { confirmed: true })).toBe(true);
      await vi.advanceTimersByTimeAsync(60_000);

      expect(record.cards.length).toBe(before);
      expect(vi.getTimerCount()).toBe(0);
      // 超时不再回一次包（请求早已 settle）。
      expect(responded).toEqual([{ id: 'ui-1', response: { confirmed: true } }]);
    } finally {
      vi.useRealTimers();
    }
  });

  it('OMP 撤回（ui_cancel）后倒计时也停掉', async () => {
    vi.useFakeTimers();
    try {
      const record = { cards: [] as object[] };
      const pending = new Set<string>(['ui-1']);
      const responded: Array<{ id: string; response: unknown }> = [];
      const activeRuns = fakeActiveRuns(pending, responded);
      const { hooks } = hooksWith(uiChannel(record), activeRuns, pending);

      await hooks.onUiRequest(confirmRequest);
      await vi.advanceTimersByTimeAsync(5000);
      const before = record.cards.length;

      // streamEvents 先删 pending，再调 onUiCancel —— 没人替它清定时器，onUiCancel 自己收。
      pending.delete('ui-1');
      await hooks.onUiCancel('ui-1');
      expect(cardText(record.cards.at(-1)!)).toContain('已取消');

      await vi.advanceTimersByTimeAsync(60_000);
      expect(record.cards.length).toBe(before + 1); // 只有那张 cancelled 结果卡
      expect(vi.getTimerCount()).toBe(0);
      expect(responded).toEqual([]);
    } finally {
      vi.useRealTimers();
    }
  });
});
