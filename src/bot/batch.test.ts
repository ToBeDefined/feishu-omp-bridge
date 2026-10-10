import { describe, expect, it } from 'vitest';
import type { LarkChannel } from '@larksuiteoapi/node-sdk';
import { streamCardPages } from './batch';
import type { AgentEvent } from '../agent/types';
import type { RunHandle } from './active-runs';
import type { WorkSessionStore } from '../session/work-store';
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
      channel, 'oc_x', {}, fakeHandle(events), {} as unknown as WorkSessionStore, 'oc_x', '/tmp',
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
      channel, 'oc_x', {}, fakeHandle(events), {} as unknown as WorkSessionStore, 'oc_x', '/tmp',
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
