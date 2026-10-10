import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { paths } from '../config/paths';
import { log } from '../core/logger';
import {
  beginWorkSession, latestSegment, touchSegment,
  type ScopeState, type WorkSegment, type WorkSession,
} from './work-session';

/**
 * 一个 scope（chat）的持久化状态：工作会话指针 + 待用名字 + /timeout 覆盖。
 *
 * `pendingTitle` 由 `/work <名字>` 写下、由下一条段落地时消费（见
 * `bindSegment`）：`/work` 只是把当前工作会话归档，下一摊活真正开张要等
 * 运行期记录下它的第一段 OMP 会话。
 */
export interface ScopeStateV2 extends ScopeState {
  /** /work <名字> 先记下，新工作会话的第一段创建时落到它的 title 上。 */
  pendingTitle?: string;
}

export interface SessionsFileV2 {
  v: 2;
  scopes: Record<string, ScopeStateV2>;
  workSessions: Record<string, WorkSession>;
}

/** v1 里每个 chat 一条：{sessionId, cwd, createdAt, updatedAt, title?, idleTimeoutMinutes?}。 */
interface V1Entry {
  sessionId?: unknown;
  cwd?: unknown;
  createdAt?: unknown;
  updatedAt?: unknown;
  title?: unknown;
  idleTimeoutMinutes?: unknown;
}

export class WorkSessionStore {
  private scopes: Record<string, ScopeStateV2> = {};
  private workSessions: Record<string, WorkSession> = {};
  private saving: Promise<void> = Promise.resolve();
  private readonly path: string;

  constructor(path: string = paths.sessionsFile) {
    this.path = path;
  }

  async load(): Promise<void> {
    try {
      const raw = JSON.parse(await readFile(this.path, 'utf8')) as Record<string, unknown>;
      this.scopes = {};
      this.workSessions = {};
      if (raw.v === 2) {
        for (const [id, ws] of Object.entries((raw.workSessions ?? {}) as Record<string, WorkSession>)) {
          if (ws && Array.isArray(ws.segments) && ws.segments.length > 0) this.workSessions[id] = ws;
        }
        for (const [scope, st] of Object.entries((raw.scopes ?? {}) as Record<string, ScopeStateV2>)) {
          this.scopes[scope] = st ?? {};
        }
        // v2 里没有的 scope 但被工作会话引用着 → 补回（防止手工编辑丢映射）
        for (const ws of Object.values(this.workSessions)) {
          if (!ws.scope) continue;
          const state = this.scopes[ws.scope];
          if (state === undefined) {
            this.scopes[ws.scope] = { activeWorkSession: ws.id };
          } else if (!this.workSessions[state.activeWorkSession ?? '']) {
            // 指针指向的工作会话已不在文件里：改指这个仍被引用的。
            this.scopes[ws.scope] = { ...state, activeWorkSession: ws.id };
          }
        }
        return;
      }
      this.migrateV1(raw);
      // 迁移本身就是一次 schema 升级：立刻把 v2 写回，文件不会长期停在 v1。
      this.schedulePersist();
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === 'ENOENT') return;
      if (err instanceof SyntaxError) {
        log.warn('session', 'load-corrupt-reset', { path: this.path });
        this.scopes = {};
        this.workSessions = {};
        return;
      }
      throw err;
    }
  }

  /** v1（chat 级 session + 标题）→ v2：每个 chat = 1 个工作会话 + 1 段。 */
  private migrateV1(raw: Record<string, unknown>): void {
    // 旧文件把 /rename 的名字放在平铺的 `titles: { sessionId: title }` 里。
    const legacyTitles = (raw['titles'] ?? {}) as Record<string, unknown>;
    for (const [scope, value] of Object.entries(raw)) {
      if (scope === 'titles') continue;
      const entry = (value ?? {}) as V1Entry;
      const idleTimeoutMinutes =
        typeof entry.idleTimeoutMinutes === 'number' ? entry.idleTimeoutMinutes : undefined;
      // 没有 updatedAt 的条目还算不上一次会话，但它可能带着 /timeout 覆盖，
      // 那是 scope 级偏好，要保住；只是不建工作会话。
      if (typeof entry.updatedAt !== 'number') {
        if (idleTimeoutMinutes !== undefined) this.scopes[scope] = { idleTimeoutMinutes };
        continue;
      }
      this.scopes[scope] = { ...(idleTimeoutMinutes !== undefined ? { idleTimeoutMinutes } : {}) };
      if (typeof entry.sessionId !== 'string' || typeof entry.cwd !== 'string') continue;
      const startedAtMs = typeof entry.createdAt === 'number' ? entry.createdAt : entry.updatedAt;
      const title =
        typeof entry.title === 'string'
          ? entry.title
          : typeof legacyTitles[entry.sessionId] === 'string'
            ? (legacyTitles[entry.sessionId] as string)
            : undefined;
      const ws = beginWorkSession(scope, {
        sessionId: entry.sessionId,
        cwd: entry.cwd,
        startedAtMs,
        lastActiveAtMs: entry.updatedAt,
      });
      if (title !== undefined) ws.title = title;
      this.workSessions[ws.id] = ws;
      this.scopes[scope] = { ...this.scopes[scope], activeWorkSession: ws.id };
    }
  }

  activeWorkSession(scope: string): WorkSession | undefined {
    const id = this.scopes[scope]?.activeWorkSession;
    return id !== undefined ? this.workSessions[id] : undefined;
  }

  workSessionById(id: string): WorkSession | undefined {
    return this.workSessions[id];
  }

  /** /history、/search、/resume 用：全部工作会话（含 scope: null 的历史）。 */
  allWorkSessions(): WorkSession[] {
    return Object.values(this.workSessions);
  }

  /** 这一 OMP 会话属于哪个工作会话。 */
  workSessionForSegment(sessionId: string): WorkSession | undefined {
    return Object.values(this.workSessions).find((ws) =>
      ws.segments.some((s) => s.sessionId === sessionId));
  }

  /** 启动通知用：有工作会话的 scope 列表。 */
  chats(): string[] {
    return Object.values(this.workSessions)
      .map((ws) => ws.scope)
      .filter((s): s is string => s !== null);
  }

  /**
   * 运行期绑定：工作会话的当前段 = 这次跑的 OMP 会话（不在则追加一段）。
   *
   * 同一段的**重跑**要把时间推到这一次（段/工作会话的 `lastActiveAtMs` = 本次
   * 运行时间），否则「同一段永远停在第一次跑的时刻」。`times` 是这段会话自己
   * 的时间戳（/resume、/history 继续对话指向历史会话时用），缺省则用“现在”。
   */
  bindSegment(
    scope: string,
    sessionId: string,
    cwd: string,
    times?: { startedAtMs?: number; lastActiveAtMs?: number },
  ): void {
    const now = Date.now();
    const at = times?.lastActiveAtMs ?? now;
    const seg: WorkSegment = {
      sessionId,
      cwd,
      startedAtMs: times?.startedAtMs ?? now,
      lastActiveAtMs: at,
    };
    const active = this.activeWorkSession(scope);
    if (active) {
      const touched = touchSegment(active, seg, at);
      const idx = touched.segments.findIndex((s) => s.sessionId === sessionId);
      // touchSegment 对已存在段取 Math.max，会把重跑的时间挡回去；这里按本次
      // 运行时间覆盖，保证「重跑 = 时间前进」。
      const segments = touched.segments.map((s, i) => (i === idx ? { ...s, lastActiveAtMs: at } : s));
      this.workSessions[active.id] = {
        ...touched,
        segments,
        currentSegmentId: sessionId,
        lastActiveAtMs: at,
        ...(active.scope === null ? { scope } : {}),
      };
    } else {
      const ws = beginWorkSession(scope, seg);
      const pending = this.scopes[scope]?.pendingTitle;
      if (pending !== undefined && pending !== '') ws.title = pending;
      this.workSessions[ws.id] = ws;
      const { pendingTitle: _drop, ...rest } = this.scopes[scope] ?? {};
      this.scopes[scope] = { ...rest, activeWorkSession: ws.id };
    }
    this.schedulePersist();
  }

  /** /new、stale 漂移：丢掉“当前段”指针，段本身留在工作会话里。 */
  dropCurrentSegment(scope: string): void {
    const active = this.activeWorkSession(scope);
    if (!active || active.currentSegmentId === undefined) return;
    const { currentSegmentId: _drop, ...rest } = active;
    this.workSessions[active.id] = rest;
    this.schedulePersist();
  }

  /** 可 resume 的 OMP 会话 id：当前段、且 cwd 一致。 */
  resumeFor(scope: string, cwd: string): string | undefined {
    const active = this.activeWorkSession(scope);
    if (!active?.currentSegmentId) return undefined;
    const seg = active.segments.find((s) => s.sessionId === active.currentSegmentId);
    return seg && seg.cwd === cwd ? seg.sessionId : undefined;
  }

  /**
   * /work：归档当前工作会话（下一次运行开一个新的）。可带一个待用名字，
   * 由下一摊活的第一段落地时落到它的 title 上。
   */
  startWorkSession(scope: string, title?: string): void {
    const { activeWorkSession: _drop, ...rest } = this.scopes[scope] ?? {};
    const pending = title?.trim();
    this.scopes[scope] = pending ? { ...rest, pendingTitle: pending } : rest;
    this.schedulePersist();
  }

  /** /resume、/history 继续对话：切到指定工作会话（绑定它最新的一段）。 */
  adoptWorkSession(scope: string, workSessionId: string, cwd?: string): boolean {
    const ws = this.workSessions[workSessionId];
    if (!ws) return false;
    const seg = latestSegment(ws);
    this.scopes[scope] = { ...this.scopes[scope], activeWorkSession: ws.id };
    this.workSessions[ws.id] = {
      ...ws,
      scope: ws.scope ?? scope,
      ...(seg !== undefined ? { currentSegmentId: seg.sessionId, cwd: cwd ?? seg.cwd } : {}),
    };
    this.schedulePersist();
    return true;
  }

  /** /rename：给当前工作会话起名。无当前工作会话时返回 false。 */
  setTitle(scope: string, title: string): boolean {
    const active = this.activeWorkSession(scope);
    if (!active) return false;
    this.workSessions[active.id] = { ...active, title };
    this.schedulePersist();
    return true;
  }

  /** /rename clear：清掉当前工作会话的名字。真的清掉了才返回 true。 */
  clearTitle(scope: string): boolean {
    const active = this.activeWorkSession(scope);
    if (!active || active.title === undefined) return false;
    const { title: _drop, ...rest } = active;
    this.workSessions[active.id] = rest;
    this.schedulePersist();
    return true;
  }

  /** 某个 OMP 会话所属工作会话的名字（/history、/search、/resume 用）。 */
  titleFor(sessionId: string | undefined): string | undefined {
    return sessionId !== undefined ? this.workSessionForSegment(sessionId)?.title : undefined;
  }

  /** Per-scope idle-timeout override. `undefined` means no override set. */
  getIdleTimeoutMinutes(scope: string): number | undefined {
    return this.scopes[scope]?.idleTimeoutMinutes;
  }

  setIdleTimeoutMinutes(scope: string, minutes: number): void {
    const clamped = Math.min(Math.max(Math.floor(minutes), 0), 120);
    this.scopes[scope] = { ...this.scopes[scope], idleTimeoutMinutes: clamped };
    this.schedulePersist();
  }

  /** Remove the override so this scope falls back to the global default.
   * Returns true if something was actually removed. */
  clearIdleTimeoutOverride(scope: string): boolean {
    const state = this.scopes[scope];
    if (!state || state.idleTimeoutMinutes === undefined) return false;
    const { idleTimeoutMinutes: _drop, ...rest } = state;
    this.scopes[scope] = rest;
    this.schedulePersist();
    return true;
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
        const payload: SessionsFileV2 = { v: 2, scopes: this.scopes, workSessions: this.workSessions };
        await writeFile(tmp, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
        await rename(tmp, this.path);
      })
      .catch((err: unknown) => log.fail('session', err, { step: 'persist' }));
  }
}
