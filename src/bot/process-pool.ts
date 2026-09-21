import { log } from '../core/logger';

/**
 * FIFO concurrency cap for OMP runs. Especially useful in topic-group
 * scenarios where each topic spawns its own run — without a cap, a single
 * busy group could trivially explode to dozens of concurrent OMP
 * subprocesses, drowning RAM and API rate limits.
 *
 * Use:
 *   const pool = new ProcessPool();
 *   const release = await pool.acquire();
 *   try { ... } finally { release(); }
 *
 * The cap is read fresh each `acquire()`, so `/config maxConcurrentRuns`
 * takes effect for the next run that asks for a slot.
 */
/**
 * How long a parked acquire() waits before re-checking the cap. Only matters
 * when the cap is raised while runs are already queued.
 */
const CAP_POLL_MS = 1000;

export class ProcessPool {
  private active = 0;
  private readonly waiters: Array<() => void> = [];
  /** Snapshot of the cap captured at the moment acquire() decided to wait. */
  private cap: () => number;

  constructor(cap: () => number) {
    this.cap = cap;
  }

  async acquire(): Promise<() => void> {
    if (this.active >= this.cap()) {
      log.info('pool', 'wait', { active: this.active, cap: this.cap(), waiting: this.waiters.length + 1 });
      // Re-check periodically: release() only wakes the next waiter when
      // there is headroom at that instant, so a cap raised via /config would
      // otherwise leave parked runs stuck until an unrelated run finished.
      while (this.active >= this.cap()) await this.waitForSlot();
    }
    this.active++;
    log.info('pool', 'acquired', { active: this.active, cap: this.cap() });
    return () => this.release();
  }

  /** Resolve on the next release, or after a poll interval to re-check the cap. */
  private waitForSlot(): Promise<void> {
    return new Promise<void>((resolve) => {
      const waiter = (): void => {
        clearTimeout(timer);
        resolve();
      };
      const timer = setTimeout(() => {
        const at = this.waiters.indexOf(waiter);
        if (at >= 0) this.waiters.splice(at, 1);
        resolve();
      }, CAP_POLL_MS);
      this.waiters.push(waiter);
    });
  }

  private release(): void {
    this.active = Math.max(0, this.active - 1);
    log.info('pool', 'released', { active: this.active });
    // Wake the next waiter if there's headroom. If cap was just lowered
    // via /config, this naturally throttles by not waking.
    if (this.active < this.cap() && this.waiters.length > 0) {
      const next = this.waiters.shift();
      if (next) next();
    }
  }

  snapshot(): { active: number; waiting: number; cap: number } {
    return { active: this.active, waiting: this.waiters.length, cap: this.cap() };
  }
}
