import type { NormalizedMessage } from '@larksuiteoapi/node-sdk';
import { log } from '../core/logger';

interface PendingEntry {
  messages: NormalizedMessage[];
  timer?: NodeJS.Timeout;
}

export type FlushHandler = (scope: string, batch: NormalizedMessage[]) => void;

/**
 * Ceiling for the busy-retry backoff. Small enough that a message queued
 * behind a long compaction is delivered promptly once the slot frees, large
 * enough that a multi-minute block costs a handful of wakeups instead of one
 * per debounce window.
 */
const BUSY_RETRY_MAX_MS = 5000;

/**
 * Per-scope debounce queue. `scope` is the session scope string (typically
 * `chatId` for p2p / regular group, `chatId:threadId` for topic groups).
 * Accumulates messages within the same scope inside a quiet window, then
 * flushes as a single batch.
 *
 * `block(scope)` pauses the debounce timer while an agent run is active on
 * that scope — pushed messages still accumulate but no flush fires until
 * `unblock(scope)`, which arms a fresh quiet window.
 *
 * Commands should bypass this queue — they're cheap and should be responsive.
 */
export class PendingQueue {
  private readonly map = new Map<string, PendingEntry>();
  private readonly blocked = new Set<string>();
  /** Current retry delay for the "slot busy" path, per scope. */
  private readonly busyDelay = new Map<string, number>();
  private readonly delayMs: number;
  private readonly onFlush: FlushHandler;

  constructor(delayMs: number, onFlush: FlushHandler) {
    this.delayMs = delayMs;
    this.onFlush = onFlush;
  }

  push(scope: string, msg: NormalizedMessage): number {
    const existing = this.map.get(scope);
    if (existing) {
      if (existing.timer) clearTimeout(existing.timer);
      existing.messages.push(msg);
      existing.timer = this.blocked.has(scope) ? undefined : this.armTimer(scope, this.delayMs);
      return existing.messages.length;
    }
    this.map.set(scope, {
      messages: [msg],
      timer: this.blocked.has(scope) ? undefined : this.armTimer(scope, this.delayMs),
    });
    return 1;
  }

  /**
   * Re-queue a batch whose slot was busy, with an exponentially growing
   * retry delay. A fixed window would re-arm once per window for the whole
   * duration of the blocking work (a large /compact can run for tens of
   * minutes), turning the wait into thousands of no-op wakeups and log lines.
   */
  pushBusyRetry(scope: string, msgs: NormalizedMessage[]): number {
    const delay = Math.min(this.busyDelay.get(scope) ?? this.delayMs, BUSY_RETRY_MAX_MS);
    this.busyDelay.set(scope, delay * 2);
    const existing = this.map.get(scope);
    if (existing) {
      if (existing.timer) clearTimeout(existing.timer);
      existing.messages.push(...msgs);
      existing.timer = this.blocked.has(scope) ? undefined : this.armTimer(scope, delay);
      return existing.messages.length;
    }
    this.map.set(scope, {
      messages: [...msgs],
      timer: this.blocked.has(scope) ? undefined : this.armTimer(scope, delay),
    });
    return msgs.length;
  }

  /** Forget the busy-retry backoff — the scope is running again. */
  resetBusyRetry(scope: string): void {
    this.busyDelay.delete(scope);
  }

  cancel(scope: string): NormalizedMessage[] {
    const entry = this.map.get(scope);
    if (!entry) return [];
    if (entry.timer) clearTimeout(entry.timer);
    this.map.delete(scope);
    return entry.messages;
  }

  cancelAll(): void {
    for (const entry of this.map.values()) {
      if (entry.timer) clearTimeout(entry.timer);
    }
    this.map.clear();
    this.blocked.clear();
    this.busyDelay.clear();
  }

  /** Pause the debounce timer; pushed messages keep accumulating. */
  block(scope: string): void {
    if (this.blocked.has(scope)) return;
    this.blocked.add(scope);
    const entry = this.map.get(scope);
    if (entry?.timer) {
      clearTimeout(entry.timer);
      entry.timer = undefined;
    }
    log.info('queue', 'blocked', { scope, queued: entry?.messages.length ?? 0 });
  }

  /** Resume the debounce timer; arms a fresh quiet window if anything queued. */
  unblock(scope: string): void {
    if (!this.blocked.has(scope)) return;
    this.blocked.delete(scope);
    const entry = this.map.get(scope);
    log.info('queue', 'unblocked', { scope, queued: entry?.messages.length ?? 0 });
    if (!entry || entry.messages.length === 0) return;
    if (entry.timer) clearTimeout(entry.timer);
    entry.timer = this.armTimer(scope, this.delayMs);
  }

  private armTimer(scope: string, delayMs: number): NodeJS.Timeout {
    return setTimeout(() => this.flush(scope), delayMs);
  }

  private flush(scope: string): void {
    const entry = this.map.get(scope);
    if (!entry) return;
    this.map.delete(scope);
    try {
      this.onFlush(scope, entry.messages);
    } catch (err) {
      log.fail('queue', err, { scope, batchSize: entry.messages.length });
    }
  }
}

/**
 * If the scope is busy (agent run or oneshot compact), push the flushed
 * batch back so the next quiet window retries. Returns true when the
 * caller must not start a run — otherwise two omp processes --resume the
 * same session jsonl.
 */
export function requeueIfBusy(
  pending: PendingQueue,
  scope: string,
  batch: NormalizedMessage[],
  busy: boolean,
): boolean {
  if (!busy) {
    pending.resetBusyRetry(scope);
    return false;
  }
  if (batch.length === 0) return false;
  pending.pushBusyRetry(scope, batch);
  log.info('flush', 'defer-busy', { scope, batchSize: batch.length });
  return true;
}
