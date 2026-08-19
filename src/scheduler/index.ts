import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { randomBytes } from 'node:crypto';
import { paths } from '../config/paths';
import { log } from '../core/logger';

export interface ScheduledTask {
  id: string;
  chatId: string;
  prompt: string;
  /** Repeat interval in milliseconds. */
  intervalMs: number;
  /** Epoch ms of the next scheduled fire. */
  nextRunAt: number;
  createdAt: number;
  /** Disabled tasks persist but never fire until re-enabled. */
  enabled: boolean;
}

/** How often the scheduler scans for due tasks (ms). */
const TICK_MS = 30_000;

/**
 * Lightweight interval-based task scheduler. Decoupled from Feishu / the
 * agent — it only tracks when tasks are due and invokes `onFire`. The bridge
 * wires `onFire` to actually run the agent and deliver the result.
 *
 * Tasks persist to disk (`scheduler.json`) so they survive bridge restarts.
 */
export class Scheduler {
  private tasks = new Map<string, ScheduledTask>();
  private timer: NodeJS.Timeout | undefined;
  private readonly file: string;
  private onFire: ((task: ScheduledTask) => void) | undefined;

  constructor(file: string = paths.schedulerFile) {
    this.file = file;
  }

  setHandler(fn: (task: ScheduledTask) => void): void {
    this.onFire = fn;
  }

  async load(): Promise<void> {
    try {
      const text = await readFile(this.file, 'utf8');
      const parsed = JSON.parse(text) as ScheduledTask[];
      for (const t of Array.isArray(parsed) ? parsed : []) {
        if (!t.id || !t.chatId || !t.prompt || typeof t.intervalMs !== 'number') continue;
        // Tolerate hand-edited / half-written files: missing `enabled` must
        // default to true, and a bogus `nextRunAt` must re-schedule rather
        // than silently never fire again.
        if (typeof t.enabled !== 'boolean') t.enabled = true;
        if (typeof t.nextRunAt !== 'number' || !Number.isFinite(t.nextRunAt)) {
          log.warn('scheduler', 'task-rescheduled', { id: t.id, reason: 'bad nextRunAt' });
          t.nextRunAt = Date.now() + t.intervalMs;
        }
        this.tasks.set(t.id, t);
      }
    } catch {
      /* ENOENT or corrupt — start empty */
    }
  }

  private async persist(): Promise<void> {
    try {
      await mkdir(dirname(this.file), { recursive: true });
      const tmp = `${this.file}.tmp-${process.pid}`;
      await writeFile(tmp, `${JSON.stringify([...this.tasks.values()], null, 2)}\n`, 'utf8');
      await rename(tmp, this.file);
    } catch (err) {
      log.fail('scheduler', err, { step: 'persist' });
    }
  }

  /** Add a task that first fires after `delayMs`, then every `intervalMs`. */
  async add(opts: {
    chatId: string;
    prompt: string;
    intervalMs: number;
    delayMs?: number;
  }): Promise<ScheduledTask> {
    const task: ScheduledTask = {
      id: randomBytes(4).toString('hex'),
      chatId: opts.chatId,
      prompt: opts.prompt,
      intervalMs: opts.intervalMs,
      nextRunAt: Date.now() + (opts.delayMs ?? opts.intervalMs),
      createdAt: Date.now(),
      enabled: true,
    };
    this.tasks.set(task.id, task);
    await this.persist();
    log.info('scheduler', 'add', { id: task.id, intervalMs: task.intervalMs, chatId: task.chatId });
    return task;
  }

  async remove(id: string): Promise<boolean> {
    const had = this.tasks.delete(id);
    if (had) await this.persist();
    return had;
  }

  list(): ScheduledTask[] {
    return [...this.tasks.values()].sort((a, b) => a.nextRunAt - b.nextRunAt);
  }

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => void this.tick(), TICK_MS);
    this.timer.unref?.();
    log.info('scheduler', 'start', { taskCount: this.tasks.size });
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
  }

  private async tick(): Promise<void> {
    const now = Date.now();
    const due = [...this.tasks.values()].filter(
      (t) => t.enabled && t.nextRunAt <= now,
    );
    for (const task of due) {
      const next = this.tasks.get(task.id);
      if (!next) continue;
      // Advance nextRunAt BEFORE firing so a slow run doesn't cause overlap;
      // the fire handler may re-schedule, but a stale copy here is fine.
      next.nextRunAt = now + next.intervalMs;
      log.info('scheduler', 'fire', { id: task.id, chatId: task.chatId });
      try {
        this.onFire?.(task);
      } catch (err) {
        log.fail('scheduler', err, { id: task.id });
      }
    }
    if (due.length > 0) await this.persist();
  }
}
