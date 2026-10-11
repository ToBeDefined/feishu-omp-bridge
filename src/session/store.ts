import { constants, copyFile, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { paths } from '../config/paths';
import { log } from '../core/logger';

/**
 * 一个 scope（chat / 话题）的会话指针 + /timeout 覆盖。
 *
 * **一个 OMP 会话 = 一个对话**：scope 只记住它现在在哪一段会话里，会话自己的
 * 目录、名字都跟着那条会话 id 走（名字见 `SessionsFile.titles`）。`sessionId`
 * 缺失表示「下一条消息开一段新对话」（`/new`、`/cd`、`/ws use` 之后，或本来
 * 就没聊过）；`cwd` 与它同进同出。
 */
export interface SessionEntry {
  /** 当前 OMP 会话 id。缺失 = 没有当前对话。 */
  sessionId?: string;
  /** 该会话的目录（`--resume` 只在会话自己的目录里有效）。 */
  cwd?: string;
  updatedAt: number;
  /** 这条会话**首次**被本 scope 绑定的时间（重跑保留，/context 显示「开始」）。 */
  createdAt?: number;
  /** Per-scope idle-timeout override (minutes). 0 = 明确关闭；undefined = 跟随全局。 */
  idleTimeoutMinutes?: number;
}

/**
 * `sessions.json` v3：`scopes` + 全局的「会话 id → 名字」表。
 *
 * v2 把多个 OMP 会话挂在同一「工作会话」下（`workSessions[].segments`），那要求
 * 用户手工 `/work merge|split`；一个 OMP 会话本就是一段对话，所以 v3 直接以
 * **会话**为单位：scope → 当前会话，名字按会话 id 存（`/rename` 命名的对象）。
 */
export interface SessionsFile {
  v: 3;
  scopes: Record<string, SessionEntry>;
  /** 会话 id → 用户起的名字（/rename）。列表里无名时回退最后一条用户消息。 */
  titles: Record<string, string>;
}

export class SessionStore {
  private scopes: Record<string, SessionEntry> = {};
  private titles: Record<string, string> = {};
  private saving: Promise<void> = Promise.resolve();
  private readonly path: string;

  constructor(path: string = paths.sessionsFile) {
    this.path = path;
  }

  /**
   * 读盘。旧格式就地迁移（v1 平铺 chat 条目 / v2 工作会话+段 → v3），迁移前留一份
   * `sessions.json.v<N>.bak`（已存在则不覆盖）。
   *
   * `opts.persist === false` 时**不**写回：CLI / 测试只想拿内存态做校验，不能让
   * 一次读取改写用户的 sessions.json。
   */
  async load(opts: { persist?: boolean } = {}): Promise<void> {
    try {
      const raw = (JSON.parse(await readFile(this.path, 'utf8')) ?? {}) as Record<string, unknown>;
      this.scopes = {};
      this.titles = {};
      const sourceVersion = raw.v === 3 ? 3 : raw.v === 2 ? 2 : 1;
      if (sourceVersion === 3) {
        this.readV3(raw);
        return;
      }
      if (sourceVersion === 2) this.migrateV2(raw);
      else this.migrateV1(raw);
      if (opts.persist !== false) {
        await this.backupOnce(`.v${sourceVersion}.bak`);
        this.schedulePersist();
      }
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === 'ENOENT') return;
      if (err instanceof SyntaxError) {
        // Corrupt file (crash mid-write, manual edit): start empty rather than
        // crash the daemon on boot. The next persist rewrites it cleanly.
        log.warn('session', 'load-corrupt-reset', { path: this.path });
        this.scopes = {};
        this.titles = {};
        return;
      }
      throw err;
    }
  }

  private readV3(raw: Record<string, unknown>): void {
    for (const [scope, entry] of Object.entries((raw.scopes ?? {}) as Record<string, unknown>)) {
      const parsed = parseEntry(entry);
      if (parsed !== undefined) this.scopes[scope] = parsed;
    }
    for (const [sessionId, title] of Object.entries((raw.titles ?? {}) as Record<string, unknown>)) {
      if (typeof title === 'string' && title.trim() !== '') this.titles[sessionId] = title;
    }
  }

  /**
   * v1：`{ "<chatId>": { sessionId, cwd, updatedAt, createdAt, title?, idleTimeoutMinutes? } }`。
   * 标题原先是 chat 级的，迁移到「会话 id → 名字」表上（挂到它当时绑定的会话）。
   */
  private migrateV1(raw: Record<string, unknown>): void {
    for (const [scope, value] of Object.entries(raw)) {
      if (scope === 'titles') {
        // 更早的形态把标题表平铺在同一层：直接收下，谁还记得自己的会话 id 谁有效。
        for (const [sid, title] of Object.entries((value ?? {}) as Record<string, unknown>)) {
          if (typeof title === 'string' && title.trim() !== '') this.titles[sid] = title;
        }
        continue;
      }
      const entry = parseEntry(value);
      if (entry === undefined) continue;
      this.scopes[scope] = entry;
      const legacyTitle = (value as Record<string, unknown>).title;
      if (
        typeof legacyTitle === 'string' &&
        legacyTitle.trim() !== '' &&
        entry.sessionId !== undefined &&
        this.titles[entry.sessionId] === undefined
      ) {
        this.titles[entry.sessionId] = legacyTitle;
      }
    }
  }

  /**
   * v2：`{ v: 2, scopes: { scope: { activeWorkSession, idleTimeoutMinutes? } }, workSessions }`。
   *
   * 一个 scope 指向它活跃工作会话的**当前段**（没有当前段则取首段）；其余段只是
   * 可恢复的历史会话，不需要在 store 里有条目 —— 它们靠会话文件出现在 /history 里。
   * 名字按 v2 的语义挂在工作会话上：迁移到该工作会话 id（= 首段 id）对应的会话。
   */
  private migrateV2(raw: Record<string, unknown>): void {
    const sessions = (raw.workSessions ?? {}) as Record<string, RawV2WorkSession>;
    for (const [id, ws] of Object.entries(sessions)) {
      if (typeof ws?.title !== 'string' || ws.title.trim() === '') continue;
      const sid = typeof ws.currentSegmentId === 'string' ? ws.currentSegmentId : id;
      this.titles[sid] = ws.title;
    }
    for (const [scope, value] of Object.entries((raw.scopes ?? {}) as Record<string, unknown>)) {
      const state = (value ?? {}) as { activeWorkSession?: unknown; idleTimeoutMinutes?: unknown };
      const idleTimeoutMinutes =
        typeof state.idleTimeoutMinutes === 'number' ? state.idleTimeoutMinutes : undefined;
      const ws = typeof state.activeWorkSession === 'string' ? sessions[state.activeWorkSession] : undefined;
      const segments = Array.isArray(ws?.segments) ? ws.segments : [];
      const current =
        segments.find((s) => s?.sessionId === ws?.currentSegmentId) ?? segments[0];
      const sessionId = typeof current?.sessionId === 'string' ? current.sessionId : undefined;
      const cwd = typeof current?.cwd === 'string' ? current.cwd : undefined;
      const hasSession = sessionId !== undefined && cwd !== undefined;
      if (!hasSession && idleTimeoutMinutes === undefined) continue;
      this.scopes[scope] = {
        ...(hasSession ? { sessionId, cwd } : {}),
        updatedAt: typeof ws?.lastActiveAtMs === 'number' ? ws.lastActiveAtMs : Date.now(),
        ...(typeof current?.startedAtMs === 'number' ? { createdAt: current.startedAtMs } : {}),
        ...(idleTimeoutMinutes !== undefined ? { idleTimeoutMinutes } : {}),
      };
    }
  }

  /** 一次性留档：升级前的文件形态出问题时能回退。只在目标不存在时写。 */
  private async backupOnce(suffix: string): Promise<void> {
    const dest = `${this.path}${suffix}`;
    try {
      await copyFile(this.path, dest, constants.COPYFILE_EXCL);
      log.info('session', 'sessions-backup', { dest });
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') {
        log.warn('session', 'sessions-backup-failed', { dest, err: String(err) });
      }
    }
  }

  /** 这个 scope 现在在哪条会话里（含它自己的 cwd）；没有当前对话时 undefined。 */
  sessionFor(scope: string): { sessionId: string; cwd: string } | undefined {
    const entry = this.scopes[scope];
    const { sessionId, cwd } = entry ?? {};
    if (sessionId === undefined || cwd === undefined) return undefined;
    return { sessionId, cwd };
  }

  /** 原始条目（含 /timeout 覆盖、createdAt 等）。 */
  getRaw(scope: string): SessionEntry | undefined {
    return this.scopes[scope];
  }

  /** 有会话指针的 scope 列表（`/ps`、占用校验用）。 */
  chats(): string[] {
    return Object.keys(this.scopes);
  }

  /**
   * 绑定：把 scope 指向 `sessionId`（**一个 OMP 会话 = 一个对话**）。
   *
   * - 同 id 重跑：只把 `updatedAt` 推到这一次，`createdAt` 保留（否则「同一会话永远
   *   停在第一次跑的时刻」）。
   * - 换了 id：`times` 给的是**那条会话自己的**时间戳（`/resume`、`继续对话` 指向历史
   *   会话时由调用方从会话文件取），缺省用“现在”。名字不用搬 —— 它按会话 id 存在
   *   `titles` 里，换回旧会话时自然还在。
   */
  bind(
    scope: string,
    sessionId: string,
    cwd: string,
    times?: { createdAtMs?: number; updatedAtMs?: number },
  ): void {
    const prev = this.scopes[scope];
    const sameSession = prev?.sessionId === sessionId;
    this.scopes[scope] = {
      sessionId,
      cwd,
      updatedAt: times?.updatedAtMs ?? Date.now(),
      ...(sameSession && prev?.createdAt !== undefined
        ? { createdAt: prev.createdAt }
        : { createdAt: times?.createdAtMs ?? Date.now() }),
      ...(prev?.idleTimeoutMinutes !== undefined
        ? { idleTimeoutMinutes: prev.idleTimeoutMinutes }
        : {}),
    };
    this.schedulePersist();
  }

  /**
   * `/new`、`/cd`、`/ws use`、运行期漂移：丢掉会话指针，下一条消息开一段**新对话**。
   *
   * 旧对话与它的名字不在这里清理：它还在会话文件里，`/history` 照样能列出来并恢复。
   */
  startNew(scope: string): void {
    const { sessionId: _sid, cwd: _cwd, ...rest } = this.scopes[scope] ?? { updatedAt: Date.now() };
    this.scopes[scope] = { ...rest, updatedAt: Date.now() };
    this.schedulePersist();
  }

  /** 整条清掉（含 /timeout 覆盖），例如 /new 的彻底重置路径。 */
  clear(scope: string): void {
    if (!(scope in this.scopes)) return;
    delete this.scopes[scope];
    this.schedulePersist();
  }

  /** 给当前会话起名（/rename）。没有当前会话时返回 false。 */
  setTitle(scope: string, title: string): boolean {
    const sessionId = this.scopes[scope]?.sessionId;
    if (sessionId === undefined) return false;
    this.titles[sessionId] = title;
    this.schedulePersist();
    return true;
  }

  /**
   * 按**会话 id** 起名：`/rename auto` 生成标题是异步的，期间 `/new`、`/cd`、
   * `/resume` 都可能换掉当前会话，名字必须落在**发起时**那一条会话上。
   *
   * 不做「这条会话还在不在」的校验：名字表按会话 id 存，历史会话（只躺在文件里、
   * 此刻没被任何 scope 绑定）同样可以起名，`/history` 立刻就能看到。
   */
  setTitleFor(sessionId: string, title: string): void {
    this.titles[sessionId] = title;
    this.schedulePersist();
  }

  /** 清掉当前会话的名字。真的清掉了才返回 true。 */
  clearTitle(scope: string): boolean {
    const sessionId = this.scopes[scope]?.sessionId;
    if (sessionId === undefined || this.titles[sessionId] === undefined) return false;
    delete this.titles[sessionId];
    this.schedulePersist();
    return true;
  }

  /** 某条会话的名字（/ctx、/status、/search、/history 用）。 */
  titleFor(sessionId: string | undefined): string | undefined {
    return sessionId !== undefined ? this.titles[sessionId] : undefined;
  }

  /** 全部「会话 id → 名字」，喂给列表面（会话文件 + 名字 → 一行）。 */
  titlesBySessionId(): Record<string, string> {
    return { ...this.titles };
  }

  /** Per-scope idle-timeout override. `undefined` means no override set. */
  getIdleTimeoutMinutes(scope: string): number | undefined {
    return this.scopes[scope]?.idleTimeoutMinutes;
  }

  setIdleTimeoutMinutes(scope: string, minutes: number): void {
    const clamped = Math.min(Math.max(Math.floor(minutes), 0), 120);
    this.scopes[scope] = { ...this.scopes[scope], idleTimeoutMinutes: clamped, updatedAt: Date.now() };
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
        // Atomic write (tmp + rename): a crash / SIGKILL mid-write must not leave
        // a truncated sessions.json behind. Matches registry / scheduler / keystore.
        const tmp = `${this.path}.tmp-${process.pid}`;
        const payload: SessionsFile = { v: 3, scopes: this.scopes, titles: this.titles };
        await writeFile(tmp, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
        await rename(tmp, this.path);
      })
      .catch((err: unknown) => log.fail('session', err, { step: 'persist' }));
  }
}

interface RawV2WorkSession {
  title?: unknown;
  currentSegmentId?: unknown;
  lastActiveAtMs?: unknown;
  segments?: Array<{ sessionId?: unknown; cwd?: unknown; startedAtMs?: unknown }>;
}

/** 读取一条 scope 条目，字段类型不对就当作缺失（手工编辑过的文件不该让 daemon 崩）。 */
function parseEntry(value: unknown): SessionEntry | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const raw = value as Record<string, unknown>;
  if (typeof raw.updatedAt !== 'number') return undefined;
  const sessionId = typeof raw.sessionId === 'string' ? raw.sessionId : undefined;
  const cwd = typeof raw.cwd === 'string' ? raw.cwd : undefined;
  const idleTimeoutMinutes =
    typeof raw.idleTimeoutMinutes === 'number' ? raw.idleTimeoutMinutes : undefined;
  const createdAt = typeof raw.createdAt === 'number' ? raw.createdAt : undefined;
  const hasSession = sessionId !== undefined && cwd !== undefined;
  // 没有会话指针但还有 /timeout 覆盖的条目要留着（否则用户设的探活会丢）。
  if (!hasSession && idleTimeoutMinutes === undefined) return undefined;
  return {
    ...(hasSession ? { sessionId, cwd } : {}),
    updatedAt: raw.updatedAt,
    ...(createdAt !== undefined ? { createdAt } : {}),
    ...(idleTimeoutMinutes !== undefined ? { idleTimeoutMinutes } : {}),
  };
}
