import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { paths } from '../config/paths';
import { log } from '../core/logger';

export interface SessionEntry {
  /** May be absent if the entry was created by /timeout before any run
   * recorded a session id. Treat absence as "no resumable session". */
  sessionId?: string;
  /** Pinned cwd for the resumable session. Absent for the same reason. */
  cwd?: string;
  updatedAt: number;
  /** When this session was first created (ms epoch). Persisted across runs
   * so /context can show "started at". Absent on pre-migration entries. */
  createdAt?: number;
  /** Per-scope idle-timeout override (minutes). 0 = explicitly off for this
   * scope, undefined = follow global default. /new clears the whole entry,
   * so this resets to "follow global" when the user starts a new session. */
  idleTimeoutMinutes?: number;
  /** User-assigned display title for the session (via /rename). Survives
   * session rollover (set keeps it) but is wiped by /new /cd /ws (clear). */
  title?: string;
}

type SessionMap = Record<string, SessionEntry>;

export class SessionStore {
  private data: SessionMap = {};
  private saving: Promise<void> = Promise.resolve();
  private readonly path: string;

  constructor(path: string = paths.sessionsFile) {
    this.path = path;
  }

  async load(): Promise<void> {
    try {
      const text = await readFile(this.path, 'utf8');
      const raw = JSON.parse(text) as Record<string, Partial<SessionEntry>>;
      this.data = {};
      for (const [chatId, entry] of Object.entries(raw)) {
        if (!entry || typeof entry.updatedAt !== 'number') continue;
        // Drop entries without a `cwd`/`sessionId` pair *unless* there's
        // some other persisted state worth keeping (e.g. an idle-timeout
        // override). Resuming a session whose cwd we don't know about
        // would make OMP resume fail, so resume keys still need
        // the full pair; but a bare timeout override is fine on its own.
        const sessionId = typeof entry.sessionId === 'string' ? entry.sessionId : undefined;
        const cwd = typeof entry.cwd === 'string' ? entry.cwd : undefined;
        const idleTimeoutMinutes =
          typeof entry.idleTimeoutMinutes === 'number' ? entry.idleTimeoutMinutes : undefined;
        const createdAt =
          typeof entry.createdAt === 'number' ? entry.createdAt : undefined;
        const title = typeof entry.title === 'string' ? entry.title : undefined;
        const hasSession = sessionId !== undefined && cwd !== undefined;
        if (!hasSession && idleTimeoutMinutes === undefined) continue;
        this.data[chatId] = {
          ...(sessionId !== undefined ? { sessionId } : {}),
          ...(cwd !== undefined ? { cwd } : {}),
          updatedAt: entry.updatedAt,
          ...(createdAt !== undefined ? { createdAt } : {}),
          ...(idleTimeoutMinutes !== undefined ? { idleTimeoutMinutes } : {}),
          // A title only makes sense on an entry that still has a session.
          ...(title !== undefined && sessionId !== undefined ? { title } : {}),
        };
      }
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return;
      // Corrupt file (crash mid-write, manual edit): start empty rather than
      // crash the daemon on boot. The next persist rewrites it cleanly.
      if (err instanceof SyntaxError) {
        log.warn('session', 'load-corrupt-reset', { path: this.path });
        this.data = {};
        return;
      }
      throw err;
    }
  }

  /**
   * Return the session id for this chat if it was created in the given cwd.
   * Sessions recorded in a different cwd are stale — OMP can't resume
   * them from a different working directory.
   */
  /** All chat ids with a persisted session entry (for startup notifications). */
  chats(): string[] {
    return Object.keys(this.data);
  }

  resumeFor(chatId: string, cwd: string): string | undefined {
    const entry = this.data[chatId];
    if (!entry) return undefined;
    if (entry.cwd !== cwd) return undefined;
    return entry.sessionId;
  }

  getRaw(chatId: string): SessionEntry | undefined {
    return this.data[chatId];
  }

  set(chatId: string, sessionId: string, cwd: string): void {
    // Preserve idleTimeoutMinutes across run starts — it's a per-scope
    // preference, not per-run-instance state. /new (clear) wipes it.
    const prev = this.data[chatId];
    this.data[chatId] = {
      sessionId,
      cwd,
      updatedAt: Date.now(),
      // First creation time survives re-runs of the same session so
      // /context can report when the conversation started.
      ...(prev?.createdAt !== undefined ? { createdAt: prev.createdAt } : { createdAt: Date.now() }),
      ...(prev?.idleTimeoutMinutes !== undefined
        ? { idleTimeoutMinutes: prev.idleTimeoutMinutes }
        : {}),
      // A user-assigned title survives rollover to a fresh OMP session in
      // the same chat (e.g. cwd kept, session recycled).
      ...(prev?.title !== undefined ? { title: prev.title } : {}),
    };
    this.schedulePersist();
  }

  clear(chatId: string): void {
    if (!(chatId in this.data)) return;
    delete this.data[chatId];
    this.schedulePersist();
  }

  /** Per-scope idle-timeout override. `undefined` means no override set. */
  getIdleTimeoutMinutes(chatId: string): number | undefined {
    return this.data[chatId]?.idleTimeoutMinutes;
  }

  setIdleTimeoutMinutes(chatId: string, minutes: number): void {
    const clamped = Math.min(Math.max(Math.floor(minutes), 0), 120);
    const prev = this.data[chatId];
    this.data[chatId] = {
      ...(prev ?? { updatedAt: Date.now() }),
      idleTimeoutMinutes: clamped,
      updatedAt: Date.now(),
    };
    this.schedulePersist();
  }

  /** Remove the override so this scope falls back to the global default.
   * Returns true if something was actually removed. */
  clearIdleTimeoutOverride(chatId: string): boolean {
    const prev = this.data[chatId];
    if (!prev || prev.idleTimeoutMinutes === undefined) return false;
    const { idleTimeoutMinutes: _, ...rest } = prev;
    this.data[chatId] = { ...rest, updatedAt: Date.now() };
    this.schedulePersist();
    return true;
  }

  /** Assign a display title to the session for this scope. */
  setTitle(chatId: string, title: string): void {
    const prev = this.data[chatId];
    this.data[chatId] = {
      ...(prev ?? { updatedAt: Date.now() }),
      title,
      updatedAt: Date.now(),
    };
    this.schedulePersist();
  }

  /** Clear the title. Returns true if one was actually removed. */
  clearTitle(chatId: string): boolean {
    const prev = this.data[chatId];
    if (!prev || prev.title === undefined) return false;
    const { title: _, ...rest } = prev;
    this.data[chatId] = { ...rest, updatedAt: Date.now() };
    this.schedulePersist();
    return true;
  }

  /** Map sessionId → title for every entry that has one. Used to annotate
   * /search hits and /resume rows that reference a session id. */
  titlesBySessionId(): Record<string, string> {
    const out: Record<string, string> = {};
    for (const entry of Object.values(this.data)) {
      if (entry.sessionId && entry.title) out[entry.sessionId] = entry.title;
    }
    return out;
  }

  async flush(): Promise<void> {
    await this.saving;
  }

  private schedulePersist(): void {
    this.saving = this.saving
      .then(async () => {
        await mkdir(dirname(this.path), { recursive: true });
        // Atomic write (tmp + rename): a crash / SIGKILL mid-write must not
        // leave a truncated sessions.json behind. Matches registry /
        // scheduler / keystore.
        const tmp = `${this.path}.tmp-${process.pid}`;
        await writeFile(tmp, `${JSON.stringify(this.data, null, 2)}\n`, 'utf8');
        await rename(tmp, this.path);
      })
      .catch((err: unknown) => {
        log.fail('session', err, { step: 'persist' });
      });
  }
}
