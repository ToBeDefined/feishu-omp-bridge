import type { LarkChannel } from '@larksuiteoapi/node-sdk';
import { readFile, unlink, writeFile } from 'node:fs/promises';
import { paths } from '../config/paths';
import { log } from '../core/logger';

interface ManagedEntry {
  cardId: string;
  sequence: number;
}

interface PersistedRunningCard {
  messageId: string;
  /** Empty for streaming cards (they patch via the message API, not cardkit). */
  cardId: string;
  chatId: string;
}

// Module-local because state is per-process. Lost on restart, which is fine —
// a new run of /account will mint a fresh card.
const byMessageId = new Map<string, ManagedEntry>();

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
  void persistRunningCards([{ messageId, cardId, chatId }], { append: true });
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
}

/** Drop the mapping; call after the card is recalled or the flow ends. */
export function forgetManagedCard(messageId: string): void {
  byMessageId.delete(messageId);
  void removeFromRunningCards(messageId);
}

const RUNNING_CARDS_MAX = 50;

async function readRunningCards(): Promise<PersistedRunningCard[]> {
  try {
    const parsed: unknown = JSON.parse(await readFile(paths.runningCardsFile, 'utf8'));
    return Array.isArray(parsed) ? (parsed as PersistedRunningCard[]) : [];
  } catch {
    return [];
  }
}

async function persistRunningCards(
  entries: PersistedRunningCard[],
  opts: { append?: boolean } = {},
): Promise<void> {
  try {
    const list = opts.append
      ? [...(await readRunningCards()), ...entries].slice(-RUNNING_CARDS_MAX)
      : entries;
    await writeFile(paths.runningCardsFile, JSON.stringify(list), 'utf8');
  } catch (err) {
    log.warn('card', 'running-cards-persist-failed', { err: String(err) });
  }
}

async function removeFromRunningCards(messageId: string): Promise<void> {
  const list = await readRunningCards();
  const next = list.filter((c) => c.messageId !== messageId);
  if (next.length !== list.length) {
    await writeFile(paths.runningCardsFile, JSON.stringify(next), 'utf8').catch(() => {});
  }
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
 * Called once at boot: cards still in-flight from the previous process get
 * finalized as interrupted, so crash-interrupted replies don't linger with a
 * live ⏹ button. Managed cards (cardId set) update via cardkit; streaming
 * cards (cardId empty) patch via the message API.
 */
export async function finalizeInterruptedCards(channel: LarkChannel): Promise<void> {
  const leftovers = await readRunningCards();
  await unlink(paths.runningCardsFile).catch(() => {});
  for (const { messageId, cardId } of leftovers) {
    try {
      if (cardId) {
        await channel.rawClient.cardkit.v1.card.update({
          path: { card_id: cardId },
          data: {
            card: { type: 'card_json', data: JSON.stringify(interruptedCard()) },
            sequence: Date.now(),
          },
        });
      } else {
        await channel.rawClient.im.v1.message.patch({
          path: { message_id: messageId },
          data: { content: JSON.stringify(interruptedCard()) },
        });
      }
      log.info('card', 'interrupted-finalized', { messageId });
    } catch (err) {
      log.warn('card', 'interrupted-finalize-failed', { messageId, err: String(err) });
    }
  }
}

/**
 * Persist a streaming reply's messageId for crash recovery. Streaming cards
 * use im.v1.message.patch (not cardkit), so they carry no cardId — the
 * boot-time finalizer patches them via the message API instead.
 */
export function rememberStreamingCard(messageId: string, chatId: string): void {
  void persistRunningCards([{ messageId, cardId: '', chatId }], { append: true });
}

/** Remove a streaming card from the crash-recovery persistence. */
export function forgetStreamingCard(messageId: string): void {
  void removeFromRunningCards(messageId);
}
