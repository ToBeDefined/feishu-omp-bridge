import type { LarkChannel } from '@larksuiteoapi/node-sdk';
import { readFile, unlink, writeFile } from 'node:fs/promises';
import { paths } from '../config/paths';
import { log } from '../core/logger';

interface ManagedEntry {
  cardId: string;
  sequence: number;
}

/**
 * Card left in-flight when the process died. `card` is the LAST rendered
 * snapshot — Feishu's message-get API only returns a card reference
 * ("请升级至最新版本客户端"), never the content, so the content must be
 * persisted locally to survive a restart.
 */
interface PersistedRunningCard {
  messageId: string;
  /** Empty for streaming cards (they patch via the message API, not cardkit). */
  cardId: string;
  chatId: string;
  card?: object;
}

// Module-local because state is per-process. Lost on restart, which is fine —
// a new run of /account will mint a fresh card.
const byMessageId = new Map<string, ManagedEntry>();

/**
 * messageIds whose card can be left mid-flight (streaming replies, progress
 * cards, forms). ONLY these are snapshotted to disk — fire-and-forget info
 * cards complete within one request and need no crash recovery, so tracking
 * them would just accumulate dead entries.
 */
const tracked = new Set<string>();

export interface ManagedCardSendResult {
  messageId: string;
  cardId: string;
}

/**
 * Create a CardKit 2.0 card instance and send a message that references it.
 * Returns both ids; we keep them in a module-local map so future cardAction
 * events can update the card by its messageId.
 *
 * If `replyTo` is provided, posts via im.v1.message.reply so the card threads
 * under the user's triggering message; otherwise posts as a top-level chat
 * message via im.v1.message.create.
 */
export async function sendManagedCard(
  channel: LarkChannel,
  chatId: string,
  card: object,
  replyTo?: string,
  opts: { track?: boolean } = {},
): Promise<ManagedCardSendResult> {
  const created = await channel.rawClient.cardkit.v1.card.create({
    data: { type: 'card_json', data: JSON.stringify(card) },
  });
  const cardId = (created as { data?: { card_id?: string } }).data?.card_id;
  if (!cardId) {
    throw new Error(`cardkit.card.create returned no card_id: ${JSON.stringify(created).slice(0, 200)}`);
  }

  const content = JSON.stringify({ type: 'card', data: { card_id: cardId } });
  let messageId: string | undefined;
  if (replyTo) {
    const sent = await channel.rawClient.im.v1.message.reply({
      path: { message_id: replyTo },
      data: { msg_type: 'interactive', content },
    });
    messageId = (sent as { data?: { message_id?: string } }).data?.message_id;
  } else {
    const sent = await channel.rawClient.im.v1.message.create({
      params: { receive_id_type: 'chat_id' },
      data: { receive_id: chatId, msg_type: 'interactive', content },
    });
    messageId = (sent as { data?: { message_id?: string } }).data?.message_id;
  }
  if (!messageId) {
    throw new Error('send card-by-reference returned no message_id');
  }

  byMessageId.set(messageId, { cardId, sequence: 0 });
  if (opts.track) {
    tracked.add(messageId);
    void upsertRunningCard({ messageId, cardId, chatId, card });
  }
  // ponytail: cap at 200; streaming run cards don't use this map. Forms
  // forget on settle; leftovers are abandoned clicks / agent cards.
  if (byMessageId.size > 200) {
    const oldest = byMessageId.keys().next().value;
    if (oldest) byMessageId.delete(oldest);
  }
  return { messageId, cardId };
}

/**
 * Update a managed card identified by the messageId of the message that
 * carries it. Auto-increments and tracks the per-card sequence so updates
 * can't be reordered or rejected by the cardkit server.
 */
export async function updateManagedCard(
  channel: LarkChannel,
  messageId: string,
  card: object,
): Promise<void> {
  const entry = byMessageId.get(messageId);
  if (!entry) {
    throw new Error(`no managed card registered for message ${messageId}`);
  }
  entry.sequence += 1;
  try {
    await channel.rawClient.cardkit.v1.card.update({
      path: { card_id: entry.cardId },
      data: {
        card: { type: 'card_json', data: JSON.stringify(card) },
        sequence: entry.sequence,
      },
    });
  } catch (err) {
    log.fail('card', err, { step: 'managed-update', cardId: entry.cardId, seq: entry.sequence });
    throw err;
  }
  if (tracked.has(messageId)) void snapshotThrottled(messageId, card);
}

/** Drop the mapping; call after the card is recalled or the flow ends. */
export function forgetManagedCard(messageId: string): void {
  byMessageId.delete(messageId);
  tracked.delete(messageId);
  lastSnapshotAt.delete(messageId);
  void removeFromRunningCards(messageId);
}

/**
 * Cap on tracked in-flight cards. Must cover peak concurrency: every
 * concurrent run (maxConcurrentRuns, default 10) can hold one streaming card,
 * plus release/restart/OMP-form cards. 50 was pure headroom — 15 covers the
 * default with margin while keeping the file tiny (entries are ~2KB typical,
 * ≤26KB by the pagination budget).
 */
const RUNNING_CARDS_MAX = 15;

/** Minimum gap between snapshot writes for one card (ms). */
const SNAPSHOT_MIN_INTERVAL_MS = 2000;

/** Per-card write throttle: a burst of updates must not rewrite the whole
 * file each time. */
const lastSnapshotAt = new Map<string, number>();

function snapshotThrottled(messageId: string, card: object): Promise<void> | false {
  const now = Date.now();
  if (now - (lastSnapshotAt.get(messageId) ?? 0) < SNAPSHOT_MIN_INTERVAL_MS) return false;
  lastSnapshotAt.set(messageId, now);
  return updateRunningCardSnapshot(messageId, card);
}

async function readRunningCards(): Promise<PersistedRunningCard[]> {
  try {
    const parsed: unknown = JSON.parse(await readFile(paths.runningCardsFile, 'utf8'));
    return Array.isArray(parsed) ? (parsed as PersistedRunningCard[]) : [];
  } catch {
    return [];
  }
}

/** Serialize writes so concurrent snapshot updates can't lose each other. */
let writeChain: Promise<void> = Promise.resolve();

async function writeRunningCards(list: PersistedRunningCard[]): Promise<void> {
  const next = writeChain.then(() =>
    writeFile(paths.runningCardsFile, JSON.stringify(list.slice(-RUNNING_CARDS_MAX)), 'utf8'),
  );
  writeChain = next.catch(() => {});
  await next.catch((err) => {
    log.warn('card', 'running-cards-persist-failed', { err: String(err) });
  });
}

/** Insert or replace the entry for a card still in flight. */
async function upsertRunningCard(entry: PersistedRunningCard): Promise<void> {
  const list = await readRunningCards();
  const next = [...list.filter((c) => c.messageId !== entry.messageId), entry];
  await writeRunningCards(next);
}

/** Refresh the persisted snapshot for one card (called on every render). */
async function updateRunningCardSnapshot(messageId: string, card: object): Promise<void> {
  const list = await readRunningCards();
  const entry = list.find((c) => c.messageId === messageId);
  if (!entry) return;
  entry.card = card;
  await writeRunningCards(list);
}

async function removeFromRunningCards(messageId: string): Promise<void> {
  const list = await readRunningCards();
  const next = list.filter((c) => c.messageId !== messageId);
  if (next.length !== list.length) await writeRunningCards(next);
}

/**
 * Called once at boot: cards still in-flight from the previous process get
 * finalized as interrupted, so crash-interrupted replies don't linger with a
 * live ⏹ button. The LAST PERSISTED SNAPSHOT is replayed with its
 * running-state chrome stripped — everything the user already saw survives.
 */
export async function finalizeInterruptedCards(
  channel: LarkChannel,
  excludeMessageId?: string,
): Promise<void> {
  const leftovers = await readRunningCards();
  await unlink(paths.runningCardsFile).catch(() => {});
  for (const { messageId, card } of leftovers) {
    if (messageId === excludeMessageId) continue;
    if (!messageId || messageId === 'om_sent' || !messageId.startsWith('om_')) continue;
    try {
      const finalCard = card ? stripRunningState(card) : interruptedCard();
      await channel.rawClient.im.v1.message.patch({
        path: { message_id: messageId },
        data: { content: JSON.stringify(finalCard) },
      });
      log.info('card', 'interrupted-finalized', { messageId, hadSnapshot: Boolean(card) });
    } catch (err) {
      log.warn('card', 'interrupted-finalize-failed', { messageId, err: String(err) });
    }
  }
}

/**
 * Replay a persisted card with running-state chrome removed: stop buttons and
 * the status footer row go away, and an interruption note is appended. All
 * content the user already saw is kept.
 */
export function stripRunningState(card: object): object {
  const elements = (card as { body?: { elements?: unknown[] } }).body?.elements;
  const kept = (Array.isArray(elements) ? elements : []).filter((el) => !isRunningStateElement(el));
  kept.push({ tag: 'markdown', content: '---', text_size: 'notation' });
  kept.push({
    tag: 'markdown',
    content: '⚠️ **进程在回复期间重启，以上为已输出的部分内容。**',
    text_size: 'notation',
  });
  return { schema: '2.0', config: { update_multi: true }, body: { elements: kept } };
}

/** Stop buttons, their action rows, and the「正在…」footer row. */
function isRunningStateElement(el: unknown): boolean {
  if (typeof el !== 'object' || el === null || !('tag' in el)) return false;
  const tag = String(el.tag);
  if (tag === 'button' || tag === 'action') return true;
  if (tag !== 'column_set') return false;
  const json = JSON.stringify(el);
  return json.includes('"cmd":"stop"') || json.includes('⏹') || /正在(思考|调用工具|输出)/.test(json);
}

function interruptedCard(): object {
  return {
    schema: '2.0',
    config: { update_multi: true },
    body: {
      elements: [
        { tag: 'markdown', content: '⚠️ **进程在回复期间重启，本条回复未完成。**' },
      ],
    },
  };
}

/**
 * Register a streaming reply card (created via channel.stream) for crash
 * recovery. Streaming cards patch via the message API, so cardId stays empty.
 */
export function rememberStreamingCard(messageId: string, chatId: string, card?: object): void {
  void upsertRunningCard({ messageId, cardId: '', chatId, ...(card ? { card } : {}) });
}

/** Refresh a streaming card's persisted snapshot (called on every render). */
export function snapshotStreamingCard(messageId: string, card: object): void {
  void updateRunningCardSnapshot(messageId, card);
}

/** Remove a streaming card from the crash-recovery persistence. */
export function forgetStreamingCard(messageId: string): void {
  void removeFromRunningCards(messageId);
}
