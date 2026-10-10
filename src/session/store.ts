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
}

type SessionMap = Record<string, SessionEntry>;

export class SessionStore {
  private data: SessionMap = {};
  /**
   * User-assigned display titles (/rename), keyed by SESSION id — a title
   * names a conversation, so it must neither follow the chat onto whatever
   * session it is next bound to (that relabelled a resumed session with the
   * previous one's name) nor vanish when the chat switches away: switching
   * back must show it again.
   */
  private titles: Record<string, string> = {};
  private saving: Promise<void> = Promise.resolve();
  private readonly path: string;

  constructor(path: string = paths.sessionsFile) {
    this.path = path;
  }

  async load(): Promise<void> {
    try {
      const text = await readFile(this.path, 'utf8');
      const raw = JSON.parse(text) as Record<string, unknown>;
      this.data = {};
      this.titles = {};
      const rawTitles = raw.titles;
      if (rawTitles && typeof rawTitles === 'object') {
        for (const [sessionId, title] of Object.entries(rawTitles as Record<string, unknown>)) {
          if (typeof title === 'string') this.titles[sessionId] = title;
        }
      }
      for (const [chatId, value] of Object.entries(raw)) {
        if (chatId === 'titles') continue;
        const entry = value as Partial<SessionEntry> & { title?: unknown };
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
        // Pre-migration files carried the title on the entry; it belongs to
        // that entry's session, so move it into the per-session map rather
        // than dropping a name the user typed.
        if (
          typeof entry.title === 'string' &&
          sessionId !== undefined &&
          this.titles[sessionId] === undefined
        ) {
          this.titles[sessionId] = entry.title;
        }
        const hasSession = sessionId !== undefined && cwd !== undefined;
        if (!hasSession && idleTimeoutMinutes === undefined) continue;
        this.data[chatId] = {
          ...(sessionId !== undefined ? { sessionId } : {}),
          ...(cwd !== undefined ? { cwd } : {}),
          updatedAt: entry.updatedAt,
          ...(createdAt !== undefined ? { createdAt } : {}),
          ...(idleTimeoutMinutes !== undefined ? { idleTimeoutMinutes } : {}),
        };
      }
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return;
      // Corrupt file (crash mid-write, manual edit): start empty rather than
      // crash the daemon on boot. The next persist rewrites it cleanly.
      if (err instanceof SyntaxError) {
        log.warn('session', 'load-corrupt-reset', { path: this.path });
        this.data = {};
        this.titles = {};
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

  /**
   * Bind the chat to a session.
   *
   * `times` are the session's OWN timestamps, for the case where the entry is
   * being pointed at a historical session (/resume, /history 继续对话): that
   * session started and was last active when it did, not now. Without them a
   * plain run/re-run stamps "now" — which is true, the run just happened.
   */
  set(
    chatId: string,
    sessionId: string,
    cwd: string,
    times?: { createdAtMs?: number; updatedAtMs?: number },
  ): void {
    // Preserve idleTimeoutMinutes across run starts — it's a per-scope
    // preference, not per-run-instance state. /new (clear) wipes it.
    const prev = this.data[chatId];
    const sameSession = prev?.sessionId === sessionId;
    this.data[chatId] = {
      sessionId,
      cwd,
      updatedAt: times?.updatedAtMs ?? Date.now(),
      // First creation time survives re-runs of the SAME session so /context
      // can report when the conversation started. A different session brings
      // its own start time — inheriting the previous one reported the old
      // conversation's birthday for the resumed one.
      ...(sameSession && prev?.createdAt !== undefined
        ? { createdAt: prev.createdAt }
        : { createdAt: times?.createdAtMs ?? Date.now() }),
      ...(prev?.idleTimeoutMinutes !== undefined
        ? { idleTimeoutMinutes: prev.idleTimeoutMinutes }
        : {}),
    };
    this.schedulePersist();
  }

  clear(chatId: string): void {
    if (!(chatId in this.data)) return;
    delete this.data[chatId];
    // Session titles stay put: the session still exists in /history, and a
    // fresh session simply has no title until the user names it.
    this.schedulePersist();
  }

  /**
   * Drop the resumable session (id + pinned cwd) but keep the scope's
   * preferences. Used when a stored id can no longer be resumed — that is a
   * rollover, not the context reset `/new` / `/cd` / `/ws` perform, so the
   * idle-timeout override must survive it. (The title lives with its session
   * id, so it is unaffected either way.)
   */
  clearSessionId(chatId: string): void {
    const prev = this.data[chatId];
    if (!prev || (prev.sessionId === undefined && prev.cwd === undefined)) return;
    const { sessionId: _id, cwd: _cwd, ...rest } = prev;
    this.data[chatId] = { ...rest, updatedAt: Date.now() };
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

  /** Assign a display title to the scope's CURRENT session. Returns false
   * when there is no session to name (so /rename can say so instead of
   * silently dropping the name). */
  setTitle(chatId: string, title: string): boolean {
    const sessionId = this.data[chatId]?.sessionId;
    if (sessionId === undefined) return false;
    this.titles[sessionId] = title;
    this.schedulePersist();
    return true;
  }

  /** Clear the CURRENT session's title. True if one was actually removed. */
  clearTitle(chatId: string): boolean {
    const sessionId = this.data[chatId]?.sessionId;
    if (sessionId === undefined || this.titles[sessionId] === undefined) return false;
    delete this.titles[sessionId];
    this.schedulePersist();
    return true;
  }

  /** Title of one specific session, when the user named it. */
  titleFor(sessionId: string | undefined): string | undefined {
    return sessionId !== undefined ? this.titles[sessionId] : undefined;
  }

  /** Map sessionId → title. Used to annotate /history rows, /search hits and
   * /resume options that reference a session id. */
  titlesBySessionId(): Record<string, string> {
    return { ...this.titles };
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
        // Entries plus the session-title map in one file: load() keys off the
        // chat ids and reads `titles` separately (a chat id never collides
        // with it — scopes are `oc_*`).
        const payload = { ...this.data, titles: this.titles };
        await writeFile(tmp, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
        await rename(tmp, this.path);
      })
      .catch((err: unknown) => {
        log.fail('session', err, { step: 'persist' });
      });
  }
}
