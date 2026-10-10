# 工作会话（Work Session）重构 Implementation Plan

> **状态：已作废（2026-10-11 晚）。** 该方案引入的「工作会话 + 段」要求用户
> 手工 `/work merge|split` 修正分段，实际使用后判定不合理：**一个 OMP 会话
> 就是一个对话**，`/resume` 直接恢复它即可。现已按新口径改造（见 CHANGELOG
> `[Unreleased]`）：`/work`、`/history seg`、合并/拆分按钮、回填 CLI 全部下线，
> 多段旧文件加载时自动规范化成「一段一对话」。下文仅作历史记录。

> **For Claude:** Use `${SUPERPOWERS_SKILLS_ROOT}/skills/collaboration/executing-plans/SKILL.md` to implement this plan task-by-task.

**Goal:** 把 bridge 的持久化单位从「chat ↔ OMP 会话」换成**工作会话**：一次工作由 `/work [名字]` 开启，`/new`、`/cd`、`/ws use`、OMP 漂移、`/resume`、`/release` 重启都只是同一工作会话里的「段」，`/history`、`/ctx`、`/status`、`/resume`、`/rename`、`/search` 全部以工作会话为单位。

**Architecture:** `sessions.json` 升到 v2（`scopes` + `workSessions`，单文件单真相、原子写）。工作会话 id = 它**第一段**的 OMP 会话 id（ULID）。段 = 一次 OMP 会话（`sessionId`/`cwd`/起止时间），由运行期自动追加/更新，不再由用户可见的"会话 id 变化"驱动。历史用一次性回填（日志里的 `/new`/`/cd`/`/ws` 事件当代理边界）归位，回填前后都能手工合并/拆分。

**Tech Stack:** TypeScript（strict + `noUncheckedIndexedAccess`）、vitest、pnpm、tsup；飞书 CardKit 2.0 卡片；无新增依赖。

---

## 0. 已定的设计口径（不要再改）

- **边界**：只有 `/work [名字]` 开新工作会话；名字可空。`/new` = 只重置上下文（同一工作会话里追加一段）。`/cd`、`/ws use`、`/resume`、OMP 漂移、`/release` 重启都不分段。
- **身份**：`workSession.id` = 第一段的 OMP `sessionId`；`segments[]` 有序保存全部段。
- **显示**：名字为空时，`/history`、`/search`、`/resume` 选择器显示该工作会话**最后一条用户消息**（`title → topic` 回退，与现 history-card 一致）。
- **`/rename` 命名当前工作会话**（`/rename clear`、`/rename auto` 同）。
- **留在 scope 上的**：`idleTimeoutMinutes`（`/timeout`）。
- **归属**：工作会话属于一个 scope（chat / chat:thread）；回填不出归属的老文件 `scope: null`，照旧可"继续"。
- **模型**：`WorkSession { id, scope|null, title?, cwd, createdAtMs, lastActiveAtMs, currentSegmentId?, segments: WorkSegment[] }`，`WorkSegment { sessionId, cwd, startedAtMs, lastActiveAtMs }`。

---

## Task 1: 工作会话的纯模型与显示回退

**Files:**
- Create: `src/session/work-session.ts`
- Test: `src/session/work-session.test.ts`

**Step 1: Write the failing test**

```ts
// src/session/work-session.test.ts
import { describe, expect, it } from 'vitest';
import {
  beginWorkSession, displayName, latestSegment, touchSegment, type WorkSession,
} from './work-session';

const seg = (id: string, cwd = '/repo', startedAtMs = 1_000) => ({
  sessionId: id, cwd, startedAtMs, lastActiveAtMs: startedAtMs,
});

describe('beginWorkSession', () => {
  it('takes its id and cwd from the first segment', () => {
    const ws = beginWorkSession('oc_1', seg('01aA', '/repo', 5));
    expect(ws).toMatchObject({
      id: '01aA', scope: 'oc_1', cwd: '/repo', createdAtMs: 5, lastActiveAtMs: 5,
      currentSegmentId: '01aA',
    });
    expect(ws.segments).toHaveLength(1);
  });
});

describe('touchSegment', () => {
  it('appends a new segment (OMP 换了会话 ⇔ 多一段)', () => {
    const ws = touchSegment(beginWorkSession('oc_1', seg('01aA')), seg('01aB', '/repo', 2_000), 2_000);
    expect(ws.segments.map((s) => s.sessionId)).toEqual(['01aA', '01aB']);
    expect(ws.currentSegmentId).toBe('01aB');
    expect(ws.lastActiveAtMs).toBe(2_000);
    // 第一段身份不变：工作会话不因为 OMP 漂移换 id
    expect(ws.id).toBe('01aA');
  });

  it('updates the same segment on a re-run instead of duplicating it', () => {
    const once = touchSegment(beginWorkSession('oc_1', seg('01aA')), seg('01aA', '/repo', 9_000), 9_000);
    expect(once.segments).toHaveLength(1);
    expect(once.segments[0]?.lastActiveAtMs).toBe(9_000);
  });
});

describe('displayName', () => {
  const ws: WorkSession = { ...beginWorkSession('oc_1', seg('01aA')), title: '  ' };
  it('falls back to the last user message when unnamed', () => {
    expect(displayName(ws, { '01aA': '看一下 KMP 的导出' })).toBe('看一下 KMP 的导出');
  });
  it('prefers the name over the topic', () => {
    expect(displayName({ ...ws, title: 'bridge UI 调整' }, { '01aA': 'x' })).toBe('bridge UI 调整');
  });
  it('returns undefined when neither exists', () => {
    expect(displayName(ws, {})).toBeUndefined();
  });
});

describe('latestSegment', () => {
  it('returns the last appended segment', () => {
    const ws = touchSegment(beginWorkSession('oc_1', seg('01aA')), seg('01aB', '/repo', 2_000), 2_000);
    expect(latestSegment(ws)?.sessionId).toBe('01aB');
  });
});
```

**Step 2: Run test to verify it fails**

Run: `npx vitest run src/session/work-session.test.ts`
Expected: FAIL — `Failed to resolve import "./work-session"`.

**Step 3: Write minimal implementation**

```ts
// src/session/work-session.ts
/**
 * 工作会话：一次"活"（由 /work 开启）。
 *
 * OMP 的会话 id 会因为 /new、/cd、/ws use、漂移、/resume、/release 重启而变；
 * 那是同一件工作里的不同**段**，不是新的工作。id 取第一段的 OMP 会话 id，
 * 让"这段工作从哪个会话开始"自明，并天然按时间有序（ULID）。
 */
export interface WorkSegment {
  /** OMP 会话 id（ULID）。 */
  sessionId: string;
  /** 该段所在的 cwd —— /cd 之后同一工作会话里会有不同 cwd 的段。 */
  cwd: string;
  startedAtMs: number;
  lastActiveAtMs: number;
}

export interface WorkSession {
  /** = segments[0].sessionId */
  id: string;
  /** 归属的 chat scope（chatId 或 chatId:threadId）；回填不出归属时为 null。 */
  scope: string | null;
  /** /rename 起的名字；空/缺省时显示回退到最后一条用户消息。 */
  title?: string;
  /** 最近一段的 cwd（/history 行的"工作目录"）。 */
  cwd: string;
  createdAtMs: number;
  lastActiveAtMs: number;
  /** 当前正在用的段（/new 会清空它，段本身留在 segments 里）。 */
  currentSegmentId?: string;
  /** 按发生顺序保存的全部段。 */
  segments: WorkSegment[];
}

/** 一个 scope（chat）的当前状态。 */
export interface ScopeState {
  /** 当前工作会话 id。 */
  activeWorkSession?: string;
  /** /timeout 覆盖（分钟，0 = 关）；留在 scope 上，不随工作会话走。 */
  idleTimeoutMinutes?: number;
}

export function beginWorkSession(scope: string | null, first: WorkSegment): WorkSession {
  return {
    id: first.sessionId,
    scope,
    cwd: first.cwd,
    createdAtMs: first.startedAtMs,
    lastActiveAtMs: first.lastActiveAtMs,
    currentSegmentId: first.sessionId,
    segments: [first],
  };
}

export function latestSegment(ws: WorkSession): WorkSegment | undefined {
  return ws.segments[ws.segments.length - 1];
}

/** 把一段并进工作会话：已存在（同一 OMP 会话再跑）就更新时间，否则追加。 */
export function touchSegment(ws: WorkSession, seg: WorkSegment, nowMs = Date.now()): WorkSession {
  const idx = ws.segments.findIndex((s) => s.sessionId === seg.sessionId);
  const segments =
    idx < 0
      ? [...ws.segments, seg]
      : ws.segments.map((s, i) =>
          i === idx ? { ...s, lastActiveAtMs: Math.max(s.lastActiveAtMs, seg.lastActiveAtMs) } : s,
        );
  const last = segments[segments.length - 1] ?? seg;
  return {
    ...ws,
    segments,
    currentSegmentId: seg.sessionId,
    cwd: last.cwd,
    lastActiveAtMs: Math.max(ws.lastActiveAtMs, nowMs),
  };
}

/** 行/标题上的名字：用户起的名字优先，否则回退该工作会话最后一条用户消息。 */
export function displayName(
  ws: WorkSession,
  lastUserMessageBySegment: Record<string, string | undefined>,
): string | undefined {
  const named = ws.title?.trim();
  if (named) return named;
  for (let i = ws.segments.length - 1; i >= 0; i -= 1) {
    const seg = ws.segments[i];
    if (!seg) continue;
    const msg = lastUserMessageBySegment[seg.sessionId]?.trim();
    if (msg) return msg;
  }
  return undefined;
}
```

**Step 4: Run test to verify it passes**

Run: `npx vitest run src/session/work-session.test.ts`
Expected: PASS (7 tests).

**Step 5: Commit**

```bash
git add src/session/work-session.ts src/session/work-session.test.ts
git commit -m "feat(session): 工作会话的纯模型（段/显示回退）"
```

---

## Task 2: `WorkSessionStore`（v2 schema + v1 迁移 + 段绑定）

**Files:**
- Create: `src/session/work-store.ts`（由 `src/session/store.ts` 整体改名而来）
- Test: `src/session/work-store.test.ts`（由 `src/session/store.test.ts` 改名 + 改写）
- Delete: `src/session/store.ts`, `src/session/store.test.ts`

**Step 1: Write the failing test**

保留 `store.test.ts` 里全部现有断言（title/times/idle 语义），追加（其余测试沿用旧文件，逐个把 `store.getRaw('oc_1')?.sessionId` 换成 `store.activeWorkSession('oc_1')?.segments.at(-1)?.sessionId` 之类）：

```ts
// src/session/work-store.test.ts（节选，追加在文件末尾的 describe 里）
import { describe, expect, it } from 'vitest';
import { WorkSessionStore } from './work-store';

describe('WorkSessionStore v2', () => {
  it('loads a v1 file as one work session with one segment', async () => {
    await writeFileAtomic(file, JSON.stringify({
      oc_1: { sessionId: 'sess-1', cwd: '/repo', updatedAt: 200, createdAt: 100, title: '旧文件里的名字' },
    }));
    const store = new WorkSessionStore(file);
    await store.load();

    const ws = store.activeWorkSession('oc_1');
    expect(ws).toMatchObject({ id: 'sess-1', scope: 'oc_1', cwd: '/repo', createdAtMs: 100 });
    expect(ws?.segments).toEqual([{ sessionId: 'sess-1', cwd: '/repo', startedAtMs: 100, lastActiveAtMs: 200 }]);
    expect(ws?.title).toBe('旧文件里的名字');
    // 旧的平铺 titles 段也要读进来
    await store.flush();
    const onDisk = JSON.parse(await readFile(file, 'utf8')) as { v: number };
    expect(onDisk.v).toBe(2);
  });

  it('appends a segment when OMP rolls to a new session (no new work session)', async () => {
    const store = new WorkSessionStore(file);
    await store.load();
    store.bindSegment('oc_1', 'sess-a', '/repo', { startedAtMs: 1, lastActiveAtMs: 1 });
    store.dropCurrentSegment('oc_1');            // stale 漂移 / /new：只丢当前段指针
    store.bindSegment('oc_1', 'sess-b', '/repo', { startedAtMs: 2, lastActiveAtMs: 2 });

    const ws = store.activeWorkSession('oc_1');
    expect(ws?.id).toBe('sess-a');
    expect(ws?.segments.map((s) => s.sessionId)).toEqual(['sess-a', 'sess-b']);
    expect(ws?.currentSegmentId).toBe('sess-b');
  });

  it('resumes only the current segment in the requested cwd', async () => {
    const store = new WorkSessionStore(file);
    await store.load();
    store.bindSegment('oc_1', 'sess-a', '/repo');
    expect(store.resumeFor('oc_1', '/repo')).toBe('sess-a');
    expect(store.resumeFor('oc_1', '/other')).toBeUndefined();   // cwd 变了 → 起新段
    store.dropCurrentSegment('oc_1');
    expect(store.resumeFor('oc_1', '/repo')).toBeUndefined();    // /new 之后不复用旧段
  });

  it('names the active work session, not the chat or the OMP session', async () => {
    const store = new WorkSessionStore(file);
    await store.load();
    store.bindSegment('oc_1', 'sess-a', '/repo');
    store.setTitle('oc_1', 'bridge UI 调整');
    store.dropCurrentSegment('oc_1');
    store.bindSegment('oc_1', 'sess-b', '/repo');

    expect(store.titleFor('sess-a')).toBe('bridge UI 调整');   // 名字跟着"这摊活"
    expect(store.titleFor('sess-b')).toBe('bridge UI 调整');
  });

  it('starts the next work session on demand and keeps the old one', async () => {
    const store = new WorkSessionStore(file);
    await store.load();
    store.bindSegment('oc_1', 'sess-a', '/repo');
    store.startWorkSession('oc_1');                 // 相当于 /work
    expect(store.activeWorkSession('oc_1')).toBeUndefined();
    store.bindSegment('oc_1', 'sess-b', '/repo', { startedAtMs: 5, lastActiveAtMs: 5 });
    expect(store.activeWorkSession('oc_1')?.id).toBe('sess-b');
    expect(store.workSessionById('sess-a')?.segments).toHaveLength(1);   // 旧工作还在
  });
});
```

**Step 2: Run test to verify it fails**

Run: `npx vitest run src/session/work-store.test.ts`
Expected: FAIL — `Failed to resolve import "./work-store"`.

**Step 3: Write minimal implementation**

```ts
// src/session/work-store.ts
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { paths } from '../config/paths';
import { log } from '../core/logger';
import {
  beginWorkSession, latestSegment, touchSegment,
  type ScopeState, type WorkSegment, type WorkSession,
} from './work-session';

export interface SessionsFileV2 {
  v: 2;
  scopes: Record<string, ScopeState>;
  workSessions: Record<string, WorkSession>;
}

/** v1 里每个 chat 一条：{sessionId, cwd, createdAt, updatedAt, title?, idleTimeoutMinutes?}。 */
interface V1Entry {
  sessionId?: unknown; cwd?: unknown; createdAt?: unknown; updatedAt?: unknown;
  title?: unknown; idleTimeoutMinutes?: unknown;
}

export class WorkSessionStore {
  private scopes: Record<string, ScopeState> = {};
  private workSessions: Record<string, WorkSession> = {};
  private saving: Promise<void> = Promise.resolve();
  private readonly path: string;

  constructor(path: string = paths.sessionsFile) { this.path = path; }

  async load(): Promise<void> {
    try {
      const raw = JSON.parse(await readFile(this.path, 'utf8')) as Record<string, unknown>;
      this.scopes = {};
      this.workSessions = {};
      if (raw.v === 2) {
        for (const [id, ws] of Object.entries((raw.workSessions ?? {}) as Record<string, WorkSession>)) {
          if (ws && Array.isArray(ws.segments) && ws.segments.length > 0) this.workSessions[id] = ws;
        }
        for (const [scope, st] of Object.entries((raw.scopes ?? {}) as Record<string, ScopeState>)) {
          this.scopes[scope] = st ?? {};
        }
        // v2 里没有的 scope 但被工作会话引用着 → 补回（防止手工编辑丢映射）
        for (const ws of Object.values(this.workSessions)) {
          if (ws.scope && !this.scopes[ws.scope]) this.scopes[ws.scope] = {};
        }
        return;
      }
      this.migrateV1(raw);
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
    const legacyTitles = (raw['titles'] ?? {}) as Record<string, unknown>;
    for (const [scope, value] of Object.entries(raw)) {
      if (scope === 'titles') continue;
      const entry = (value ?? {}) as V1Entry;
      if (typeof entry.updatedAt !== 'number') continue;
      const idleTimeoutMinutes =
        typeof entry.idleTimeoutMinutes === 'number' ? entry.idleTimeoutMinutes : undefined;
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
        sessionId: entry.sessionId, cwd: entry.cwd, startedAtMs, lastActiveAtMs: entry.updatedAt,
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

  workSessionById(id: string): WorkSession | undefined { return this.workSessions[id]; }

  /** /history、/search、/resume 用：全部工作会话（含 scope: null 的历史）。 */
  allWorkSessions(): WorkSession[] { return Object.values(this.workSessions); }

  /** 这一 OMP 会话属于哪个工作会话。 */
  workSessionForSegment(sessionId: string): WorkSession | undefined {
    return Object.values(this.workSessions).find((ws) =>
      ws.segments.some((s) => s.sessionId === sessionId));
  }

  /** 运行期绑定：工作会话的当前段 = 这次跑的 OMP 会话（不在则追加一段）。 */
  bindSegment(
    scope: string,
    sessionId: string,
    cwd: string,
    times?: { startedAtMs?: number; lastActiveAtMs?: number },
  ): void {
    const now = Date.now();
    const seg: WorkSegment = {
      sessionId,
      cwd,
      startedAtMs: times?.startedAtMs ?? now,
      lastActiveAtMs: times?.lastActiveAtMs ?? now,
    };
    const active = this.activeWorkSession(scope);
    if (active) {
      this.workSessions[active.id] = touchSegment(active, seg, now);
      if (active.scope === null) this.workSessions[active.id].scope = scope;
    } else {
      const ws = beginWorkSession(scope, seg);
      this.workSessions[ws.id] = ws;
      this.scopes[scope] = { ...this.scopes[scope], activeWorkSession: ws.id };
    }
    this.schedulePersist();
  }

  /** /new、stale 漂移：丢掉"当前段"指针，段本身留在工作会话里。 */
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

  /** /work：归档当前工作会话，下一次运行开一个新的。 */
  startWorkSession(scope: string): void {
    const { activeWorkSession: _drop, ...rest } = this.scopes[scope] ?? {};
    this.scopes[scope] = rest;
    this.schedulePersist();
  }

  /** /resume、/history 继续对话：切到指定工作会话（绑定它最新的一段）。 */
  adoptWorkSession(scope: string, workSessionId: string, cwd?: string): boolean {
    const ws = this.workSessions[workSessionId];
    if (!ws) return false;
    const seg = latestSegment(ws);
    this.scopes[scope] = { ...this.scopes[scope], activeWorkSession: ws.id };
    this.workSessions[ws.id] = { ...ws, scope: ws.scope ?? scope, currentSegmentId: seg?.sessionId };
    if (seg) {
      this.workSessions[ws.id] = { ...this.workSessions[ws.id]!, cwd: cwd ?? seg.cwd };
    }
    this.schedulePersist();
    return true;
  }

  setTitle(scope: string, title: string): boolean {
    const active = this.activeWorkSession(scope);
    if (!active) return false;
    this.workSessions[active.id] = { ...active, title };
    this.schedulePersist();
    return true;
  }

  clearTitle(scope: string): boolean {
    const active = this.activeWorkSession(scope);
    if (!active || active.title === undefined) return false;
    const { title: _drop, ...rest } = active;
    this.workSessions[active.id] = rest;
    this.schedulePersist();
    return true;
  }

  titleFor(sessionId: string | undefined): string | undefined {
    return sessionId !== undefined ? this.workSessionForSegment(sessionId)?.title : undefined;
  }

  getIdleTimeoutMinutes(scope: string): number | undefined {
    return this.scopes[scope]?.idleTimeoutMinutes;
  }

  setIdleTimeoutMinutes(scope: string, minutes: number): void {
    const clamped = Math.min(Math.max(Math.floor(minutes), 0), 120);
    this.scopes[scope] = { ...this.scopes[scope], idleTimeoutMinutes: clamped };
    this.schedulePersist();
  }

  clearIdleTimeoutOverride(scope: string): boolean {
    const state = this.scopes[scope];
    if (!state || state.idleTimeoutMinutes === undefined) return false;
    const { idleTimeoutMinutes: _drop, ...rest } = state;
    this.scopes[scope] = rest;
    this.schedulePersist();
    return true;
  }

  /** 启动通知用：有工作会话的 scope 列表。 */
  chats(): string[] {
    return Object.values(this.workSessions)
      .map((ws) => ws.scope)
      .filter((s): s is string => s !== null);
  }

  async flush(): Promise<void> { await this.saving; }

  private schedulePersist(): void {
    this.saving = this.saving
      .then(async () => {
        await mkdir(dirname(this.path), { recursive: true });
        const tmp = `${this.path}.tmp-${process.pid}`;
        const payload: SessionsFileV2 = { v: 2, scopes: this.scopes, workSessions: this.workSessions };
        await writeFile(tmp, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
        await rename(tmp, this.path);
      })
      .catch((err: unknown) => log.fail('session', err, { step: 'persist' }));
  }
}
```

**Step 4: Run test to verify it passes**

Run: `npx vitest run src/session/work-store.test.ts`
Expected: PASS。旧文件里的 title/times/idle 断言全部保留并通过（`clearSessionId` → `dropCurrentSegment`、`set` → `bindSegment`、`resumeFor` 同名）。

**Step 5: Commit**

```bash
git add src/session/work-store.ts src/session/work-store.test.ts
git rm src/session/store.ts src/session/store.test.ts
git commit -m "feat(session): WorkSessionStore（v2 schema + v1 迁移 + 段绑定）"
```

---

## Task 3: 全量改调用点（clean cutover，不留 shim）

**Files:**
- Modify: `src/commands/index.ts`（`sessions: SessionStore` → `workSessions: WorkSessionStore`）
- Modify: `src/bot/batch.ts`、`src/bot/channel.ts`、`src/bot/intake.ts`、`src/bot/comments.ts`、`src/bot/card-dispatcher.ts`、`src/cli/commands/start.ts`
- Modify: `src/commands/session/{context,status,history,resume,rename,search}.ts`（字段名 + 新语义，见后续 Task）

**Step 1: 机械替换 + 语义对齐**

```bash
# 1) 类型/命名：SessionStore → WorkSessionStore，ctx.sessions → ctx.workSessions
grep -rl "SessionStore\|from '../session/store'\|from '../../session/store'" src | xargs sed -i '' \
  -e "s/from '\(.*\)session\/store'/from '\1session\/work-store'/" \
  -e 's/\bSessionStore\b/WorkSessionStore/g'
grep -rl "ctx\.sessions\|deps\.sessions\|sessions\." src | xargs sed -i '' -e 's/ctx\.sessions\./ctx.workSessions./g'
```

**2) `batch.ts` 的三处语义变化**（这是本任务的核心，不只是改名）：

- 起跑绑定：`sessions.set(scope, evt.sessionId, effectiveCwd)` → 保留，但传该次运行的时间：
  ```ts
  // src/bot/batch.ts，streamEvents 的 'system' 分支
  sessions.set(scope, evt.sessionId, effectiveCwd);       // 旧
  workSessions.bindSegment(scope, evt.sessionId, effectiveCwd);   // 新（startedAt=now）
  ```
- stale 漂移：`sessions.clearSessionId(scope)` → `workSessions.dropCurrentSegment(scope)`（语义相同：不复用死段，但段留在工作会话里，`/history` 仍看得到）。
- `sessions.resumeFor(scope, cwd)` 不变（改名）。

**Step 2: Typecheck**

Run: `pnpm typecheck`
Expected: 只有 Task 4+ 还没改的命令文件会报错 → 把它们一并改完再继续。

**Step 3: Run the suite**

Run: `pnpm test`
Expected: PASS（`batch.test.ts` 等 fake 里的 `sessions:` 桩要同步改名成 `workSessions`，桩对象补 `bindSegment/dropCurrentSegment/resumeFor`）。

**Step 4: Commit**

```bash
git add -A src
git commit -m "refactor(session): 调用点切到 WorkSessionStore"
```

---

## Task 4: `/work [名字]` 命令

**Files:**
- Create: `src/commands/session/work.ts`
- Modify: `src/commands/session/index.ts`（导出 `workHandlers`）、`src/commands/index.ts`（注册 + 帮助文案）
- Test: `src/commands/session/work.test.ts`

**Step 1: Write the failing test**

```ts
// src/commands/session/work.test.ts
import { describe, expect, it, vi } from 'vitest';
import { handleWork } from './work';

const { reply } = vi.hoisted(() => ({ reply: vi.fn(async () => {}) }));
vi.mock('../shared', () => ({ reply }));

function makeCtx(over: Record<string, unknown> = {}) {
  const calls: string[] = [];
  return {
    ctx: {
      scope: 'oc_1',
      sessions: {
        startWorkSession: (s: string) => calls.push(`start:+${s};name=+${(globalThis as any).__name ?? ''}`),
        setTitle: (_s: string, t: string) => { calls.push(`title:${t}`); return true; },
      },
      ...over,
    } as never,
    calls,
  };
}

describe('/work', () => {
  it('archives the current work session and names the new one', async () => {
    const { ctx, calls } = makeCtx();
    await handleWork('会话重构', ctx);
    expect(calls[0]).toContain('start:');
    expect(calls[1]).toBe('title:会话重构');
    expect(reply).toHaveBeenCalledWith(ctx, expect.stringContaining('已开始新工作会话'));
  });

  it('works without a name (行内回退到最后一条消息)', async () => {
    const { ctx, calls } = makeCtx();
    await handleWork('', ctx);
    expect(calls.some((c) => c.startsWith('title:'))).toBe(false);
    expect(reply).toHaveBeenCalledWith(ctx, expect.stringContaining('未命名'));
  });

  it('rejects an over-long name', async () => {
    const { ctx } = makeCtx();
    await handleWork('x'.repeat(61), ctx);
    expect(reply).toHaveBeenCalledWith(ctx, expect.stringContaining('过长'));
  });
});
```

**Step 2: Run test to verify it fails**

Run: `npx vitest run src/commands/session/work.test.ts`
Expected: FAIL — `Failed to resolve import "./work"`.

**Step 3: Write minimal implementation**

```ts
// src/commands/session/work.ts
import type { CommandContext, Handler } from '../index';
import { reply } from '../shared';
import { codeSpan } from '../../utils/text';
import { escapeMd } from '../../card/templates';

export const workHandlers: Record<string, Handler> = { '/work': handleWork };

const NAME_MAX = 60;

/**
 * `/work [名字]` — 开始一件新工作。
 *
 * 这是唯一的工作会话边界：`/new`、`/cd`、`/ws use`、`/resume`、OMP 漂移、
 * `/release` 重启都只是同一个工作会话里的段。
 */
export async function handleWork(args: string, ctx: CommandContext): Promise<void> {
  const name = args.trim();
  if (name.length > NAME_MAX) {
    await reply(ctx, `❌ 名字过长（上限 ${NAME_MAX} 字符）。`);
    return;
  }
  ctx.activeRuns.interrupt(ctx.scope);
  ctx.workSessions.startWorkSession(ctx.scope);
  if (name) ctx.workSessions.setTitle(ctx.scope, name);
  await reply(
    ctx,
    name
      ? `✅ 已开始新工作会话：${codeSpan(name)}\n下一条消息在这个工作会话里继续。`
      : '✅ 已开始新工作会话（未命名，列表里显示最后一条消息）。\n下一条消息在这个工作会话里继续。',
  );
}
```

`ctx.workSessions.startWorkSession` 之后还没有工作会话，所以 `setTitle` 会返回 false —— 因此 `/work <名字>` 的名字要**挂到新工作会话创建之后**：改成把待用名字暂存在 scope 上（`ScopeState.pendingTitle`），或在 `startWorkSession(scope, title?)` 里一并写入。**采用后者**（实现里给 `WorkSessionStore.startWorkSession` 加可选 `title`，并存进 `ScopeState.pendingTitle`，`bindSegment` 创建新工作会话时落到 `ws.title`）。同步给 `work.test.ts` 的桩补 `startWorkSession(scope, title?)`。

**Step 4: Run test to verify it passes**

Run: `npx vitest run src/commands/session/work.test.ts`
Expected: PASS (3 tests)。

**Step 5: 注册 + 提交**

```bash
# src/commands/session/index.ts: export { workHandlers } from './work';
# src/commands/index.ts: ...workHandlers 展开进 handlers；'/work' 加入 commands 白名单；helpCard 增加一行
git add src/commands/session/work.ts src/commands/session/work.test.ts src/commands/session/index.ts src/commands/index.ts
git commit -m "feat(command): /work 开启工作会话（名字可空）"
```

---

## Task 5: `/new` 只重置上下文（不再换工作会话）

**Files:**
- Modify: `src/commands/session/new.ts`（`ctx.sessions.clear(ctx.scope)` → `ctx.workSessions.dropCurrentSegment(ctx.scope)`）
- Test: `src/commands/session/new.test.ts`（若无则新建）

**Step 1: Write the failing test**

```ts
it('keeps the work session and just starts a new segment', async () => {
  const { ctx, calls } = makeNewCtx();
  await handleNew('', ctx);
  expect(calls).toContain('dropCurrentSegment');
  expect(calls).not.toContain('startWorkSession');
});
```

**Step 2–4:** 跑红 → 改 `new.ts`（`clear` 已不存在，必须换成 `dropCurrentSegment`）→ 跑绿。

**Step 5: 文案**

`newSessionCard` 的说明改成"已重置上下文（同一工作会话，新的一段）"，并在有当前工作会话名字时带上它。

```bash
git add src/commands/session/new.ts src/commands/session/new.test.ts src/card/templates.ts
git commit -m "feat(command): /new 只重置上下文，不再切工作会话"
```

---

## Task 6: `/rename` 命名工作会话（含 auto）

**Files:**
- Modify: `src/commands/session/rename.ts`（`titleFor(ctx.workSessions.getRaw(scope)?.sessionId)` → 当前工作会话的显示名；`/rename auto` 的取样窗口 = 当前工作会话最新段）
- Test: `src/commands/session/rename.test.ts`（已存在的用例改桩，新增"命名的是工作会话"）

**Step 1: Write the failing test**

```ts
it('names the WORK session: OMP 换段后名字还在', async () => {
  const store = new WorkSessionStore(join(tmp, 'sessions.json'));
  await store.load();
  store.bindSegment('oc_1', 'sess-a', tmp);
  const ctx = makeCtx({ sessions: store });
  await handleRename('bridge UI 调整', ctx);

  store.dropCurrentSegment('oc_1');           // /new → 新段
  store.bindSegment('oc_1', 'sess-b', tmp);
  expect(store.titleFor('sess-b')).toBe('bridge UI 调整');
  expect(renderContext(ctx, {}).sessionTitle).toBe('bridge UI 调整');
});
```

**Step 2–5:** 红 → 改 → 绿 → 提交（`git commit -m "feat(command): /rename 命名当前工作会话"`）。

---

## Task 7: `/ctx` 与 `/status` 展示工作会话

**Files:**
- Modify: `src/commands/session/context.ts`、`src/commands/session/status.ts`、`src/card/templates.ts`（`ContextInfo` / `StatusInfo` 字段）

**Step 1: Write the failing test**（`src/commands/session.test.ts` 里追加）

```ts
it('reports the work session, not the OMP session id, as the identity', () => {
  const md = renderContext(makeCtx({ /* workSessions: 一个带 2 段的工作会话 */ }), {});
  expect(md).toContain('**工作会话**: `01aA…` _（2 段）_');
  expect(md).toContain('**标题**: `bridge UI 调整`');      // 名字优先
  expect(md).toContain('**当前段**: `01aB…`');
});
```

字段：`workSessionId`、`workSessionName?`（= `displayName`）、`segmentCount`、`currentSessionId?`、`cwd`（= 最新段 cwd）、`createdAt`（= 工作会话 `createdAtMs`）、`updatedAt`（= `lastActiveAtMs`）。行文案：

```
💬 **聊天窗口**: …
📁 **工作目录**: `…`（若是多目录工作会话，追加 `_（N 段 · M 个目录）_`）
🧠 **工作会话**: `<ws.id>` _（N 段）_        ← 现在是"会话 ID"，改成工作会话 id
🏷 **标题**: `<名字或"未命名">`              ← 名字为空时给"未命名"，topic 走"最后消息"行
🕒 **开始**: <创建时间>   🕘 **最后活动**: <相对时间>
🧵 **当前段**: `<当前 OMP 会话 id>` _（最近活动 <相对时间>）_
```

**Step 2–5:** 红 → 改 → 绿 → 提交（`git commit -m "feat(card): /ctx 与 /status 以工作会话为单位"`）。

---

## Task 8: `/history` 行 = 工作会话

**Files:**
- Modify: `src/commands/session/sessions.ts`（`listSessions` → `listWorkSessions`：扫文件得每段的 turns/最后消息/mtime，再按工作会话聚合；无归属的历史文件各自成一条 `scope: null` 工作会话）
- Modify: `src/commands/session/history.ts`、`src/card/history-card.ts`
- Test: `src/commands/session/history.test.ts`、`src/card/history-card.test.ts`

**Step 1: Write the failing test**

```ts
it('lists one row per work session, not per OMP session', async () => {
  const rows = await listWorkSessions(ctx);       // ctx.workSessions 里：ws#1 有 3 段，ws#2 有 1 段
  expect(rows).toHaveLength(2);
  expect(rows[0]).toMatchObject({ workSessionId: 'ws-1', segmentCount: 3, turns: 12 });
});

it('falls back from name to the last user message', () => {
  const card = historyCard([row({ topic: '看一下 KMP 的导出' })], { mode: 'cwd', offset: 0, total: 1 });
  expect(JSON.stringify(card)).toContain('看一下 KMP 的导出');
});
```

卡片行：`#N 🏷 名字 | ✅当前 ｜ 💬 最后消息 · 🧵 N 段 · 🔁 M 轮 · 📁 cwd · 🕘 时间`，按钮 `继续对话`（= `applyResume` 到该工作会话最新段）、`🧵 段`（列出各段，每段一个恢复按钮，`history.seg <wsId> <n>`）。

**Step 2–5:** 红 → 改 → 绿 → 提交（`git commit -m "feat(card): /history 按工作会话列一行"`）。

---

## Task 9: `/resume` 选择器 = 工作会话

**Files:**
- Modify: `src/commands/session/resume.ts`（`listResumableSessions` 返回工作会话；`applyResume` 改调 `workSessions.adoptWorkSession(scope, wsId)`，cwd 用最新段的 cwd 做 `resolveSafeCwd`；跨 scope 占用保护保留）
- Modify: `src/card/model-card.ts`（`ResumeOption` 增 `workSessionId/segmentCount`；行内显示名字→最后消息）
- Test: `src/commands/session/resume.test.ts`

**Step 1–5:** 先写"恢复工作会话后 `/ctx` 显示该工作会话、且 `resumeFor` 指向它最新段"的失败测试，再改到绿，提交（`git commit -m "feat(command): /resume 以工作会话为单位"`）。

---

## Task 10: `/search` 标题按工作会话

**Files:**
- Modify: `src/commands/session/search.ts`（`titlesBySessionId()` → `workSessionForSegment(sessionId)` + `displayName` 回退）
- Modify: `src/card/search-card.ts`（命中行的身份行同上）
- Test: `src/commands/session/search.test.ts`、`src/card/search-card.test.ts`

**Step 1–5:** 断点：同一工作会话的多段命中合并成一个标题（名字或最后消息），跑绿后提交（`git commit -m "feat(card): /search 按工作会话标注"`）。

---

## Task 11: 历史回填（纯函数 + 单测）

**Files:**
- Create: `src/session/backfill.ts`
- Test: `src/session/backfill.test.ts`

**Step 1: Write the failing test**

```ts
import { describe, expect, it } from 'vitest';
import { backfillWorkSessions, type LogEvent, type SegmentMeta } from './backfill';

const seg = (sessionId: string, cwd: string, startedAtMs: number, mtimeMs: number): SegmentMeta =>
  ({ sessionId, cwd, startedAtMs, lastActiveAtMs: mtimeMs });

const log: LogEvent[] = [
  { ts: 1, kind: 'bind', scope: 'oc_1', sessionId: 'A' },
  { ts: 2, kind: 'boundary', scope: 'oc_1', cmd: '/new' },
  { ts: 3, kind: 'bind', scope: 'oc_1', sessionId: 'B' },
  { ts: 4, kind: 'bind', scope: 'oc_1', sessionId: 'A' },      // /resume 回 A：不应合并回 B 段
];

describe('backfillWorkSessions', () => {
  it('groups each session by the FIRST binding, split only at /new|/cd|/ws boundaries', () => {
    const { workSessions } = backfillWorkSessions(
      { scopes: {}, workSessions: {} },
      log,
      [seg('A', '/repo', 1, 10), seg('B', '/repo', 3, 30)],
    );
    const ids = Object.keys(workSessions);
    expect(ids.sort()).toEqual(['A', 'B']);
    expect(workSessions['A']?.segments.map((s) => s.sessionId)).toEqual(['A']);
    expect(workSessions['B']?.scope).toBe('oc_1');
  });

  it('keeps sessions with no log coverage as their own unnamed work session', () => {
    const { workSessions } = backfillWorkSessions(
      { scopes: {}, workSessions: {} },
      log,
      [seg('A', '/repo', 1, 10), seg('Z', '/tmp', 0, 5)],
    );
    expect(workSessions['Z']).toMatchObject({ scope: null, cwd: '/tmp' });
  });

  it('is idempotent and never overwrites existing work sessions', () => {
    const first = backfillWorkSessions({ scopes: {}, workSessions: {} }, log, [seg('A', '/repo', 1, 10), seg('B', '/repo', 3, 30)]);
    const again = backfillWorkSessions(first, log, [seg('A', '/repo', 1, 10), seg('B', '/repo', 3, 30)]);
    expect(again.workSessions).toEqual(first.workSessions);
  });
});
```

**Step 2: Run test to verify it fails.** Run: `npx vitest run src/session/backfill.test.ts` → FAIL。

**Step 3: Write minimal implementation**

```ts
// src/session/backfill.ts
import { beginWorkSession, touchSegment, type WorkSession, type WorkSegment } from './work-session';
import type { SessionsFileV2 } from './work-store';

/** 日志里能用的三类事件（/new|/cd|/ws 是边界；bind 是 chat↔OMP 会话）。 */
export type LogEvent =
  | { ts: number; kind: 'bind'; scope: string; sessionId: string }
  | { ts: number; kind: 'boundary'; scope: string; cmd: string };

export interface SegmentMeta {
  sessionId: string; cwd: string; startedAtMs: number; lastActiveAtMs: number;
}

/**
 * 按日志回填工作会话：
 *  - 段的归属 = 它在日志里的**首次**绑定落在哪个边界区间（/resume 的再次绑定不迁移、不合并）；
 *  - 边界 = 同一 scope 上的 `/new`、`/cd`、`/ws`（历史里没有 /work，只能拿它们当代理）；
 *  - 日志覆盖不到的段 → 各自一个 `scope: null` 的工作会话；
 *  - 已有的工作会话不动（幂等）。
 */
export function backfillWorkSessions(
  base: SessionsFileV2,
  log: LogEvent[],
  segments: SegmentMeta[],
): SessionsFileV2 {
  const workSessions: Record<string, WorkSession> = { ...base.workSessions };
  const claimed = new Set(
    Object.values(workSessions).flatMap((ws) => ws.segments.map((s) => s.sessionId)),
  );
  const boundaries = new Map<string, number[]>();
  for (const ev of log) {
    if (ev.kind !== 'boundary') continue;
    const list = boundaries.get(ev.scope) ?? [];
    list.push(ev.ts);
    boundaries.set(ev.scope, list);
  }
  for (const list of boundaries.values()) list.sort((a, b) => a - b);

  const firstBinding = new Map<string, { ts: number; scope: string }>();
  for (const ev of [...log].sort((a, b) => a.ts - b.ts)) {
    if (ev.kind !== 'bind' || firstBinding.has(ev.sessionId)) continue;
    firstBinding.set(ev.sessionId, { ts: ev.ts, scope: ev.scope });
  }
  // 同一区间里的段 → 同一个工作会话（id 取区间内最早的段）
  const groupKey = new Map<string, string>();
  for (const seg of segments) {
    if (claimed.has(seg.sessionId)) continue;
    const seen = firstBinding.get(seg.sessionId);
    const scope = seen?.scope ?? null;
    const idx = seen ? (boundaries.get(seen.scope) ?? []).filter((t) => t < seen.ts).length : 0;
    const key = scope ? `${scope}#${idx}` : `#${seg.sessionId}`;
    const ownerId = groupKey.get(key) ?? seg.sessionId;
    groupKey.set(key, ownerId);
    const existing = workSessions[ownerId];
    const ws = existing
      ? touchSegment(existing, seg as WorkSegment, seg.lastActiveAtMs)
      : beginWorkSession(scope, seg as WorkSegment);
    workSessions[ownerId] = ws;
    claimed.add(seg.sessionId);
  }
  // 当前工作会话：日志里最后绑定的段所归属的那个
  const scopes = { ...base.scopes };
  const tail = [...log].filter((e): e is Extract<LogEvent, { kind: 'bind' }> => e.kind === 'bind').pop();
  if (tail) {
    const owner = Object.values(workSessions).find((ws) =>
      ws.segments.some((s) => s.sessionId === tail.sessionId));
    if (owner) scopes[tail.scope] = { ...scopes[tail.scope], activeWorkSession: owner.id };
  }
  return { v: 2, scopes, workSessions };
}
```

**Step 4: Run test to verify it passes.** Run: `npx vitest run src/session/backfill.test.ts` → PASS。

**Step 5: Commit**

```bash
git add src/session/backfill.ts src/session/backfill.test.ts
git commit -m "feat(session): 历史回填（日志边界 + 首次绑定归属，幂等）"
```

---

## Task 12: CLI `bridge migrate work-sessions`（默认 dry-run）

**Files:**
- Create: `src/cli/commands/work-sessions.ts`（读 `paths.sessionsFile` + `logs/2026-*.log` + `omp-sessions/*.jsonl` 头部/mtime → 调 `backfillWorkSessions`）
- Modify: `src/cli/index.ts`（`.command('work-sessions')` + `--apply`）
- Test: `src/cli/commands/work-sessions.test.ts`（用临时目录 + 假日志/假会话文件，断言 dry-run 不写盘、`--apply` 写 v2 且先生成 `sessions.json.v1.bak`）

**Dry-run 输出样例（要照这个格式做）**

```
$ feishu-omp-bridge migrate work-sessions
（dry-run，不写盘；加 --apply 落盘）

当前文件: /Users/tbd/.feishu-omp-bridge/sessions.json (v1)
日志: logs/2026-10-04.log … 2026-10-10.log（7 天）
会话文件: 80 个（78 个有归属、2 个无归属）

oc_95f0…（当前工作会话 = 01a0d5e9）
  ├ 01a0f2d8  10-04→10-10  1 段
  ├ 01a11d26  「bridge UI 调整」  10-08→10-11  1 段
  ├ 01a12139  10-09→10-10  1 段
  └ 01a0d5e9  10-10→10-11  1 段

无归属（日志覆盖不到，各自 1 条）
  └ 01a0d411 / 01a0969b / …

写盘: 备份 sessions.json.v1.bak，然后写 v2
```

**Step 1–5:** 红 → 实现 → 绿 → 提交（`git commit -m "feat(cli): migrate work-sessions 回填工作会话（默认 dry-run）"`）。

---

## Task 13: 手工「合并 / 拆分」

**Files:**
- Modify: `src/commands/session/work.ts`（`/work merge <序号>`、`/work split <序号> <段序号>`）
- Modify: `src/card/history-card.ts`（行内按钮 `work.merge` / `work.split`，payload 走既有 `cmd` 映射）
- Modify: `src/bot/card-dispatcher.ts`（把 `work.merge|work.split` 的按钮 payload 映射成 `work merge …` 子命令）
- Test: `src/commands/session/work.test.ts`

语义：merge = 把目标工作会话的段并入**上一条**（`segments` 拼接，`id` 取更早那条，`title` 保留较早的非空名字，更新 `cwd/lastActiveAtMs`，删除被并入的那条）；split = 从第 N 段起切出一个新工作会话（`id` = 该段 id，`scope` 相同，`currentSegmentId` 随之搬移）。

**Step 1–5:** 每个动作先写失败测试再实现，绿后提交（`git commit -m "feat(command): /work merge|split 手工修正历史分段"`）。

---

## Task 13.5: `/history` 段列表（`history.seg <wsId>`）

**Files:**
- Modify: `src/commands/session/history.ts`（新子命令 `seg`：列出该工作会话的各段，每段一个恢复按钮 `resume <sessionId>`）
- Test: `src/commands/session/history.test.ts`

**Step 1–5:** 红 → 实现 → 绿 → 提交（`git commit -m "feat(command): /history seg 查看工作会话的各段"`）。

---

## Task 14: 文档 + 收尾

**Files:**
- Modify: `README.md`（命令表加 `/work`；新增「工作会话」一节：定义、边界、段、显示回退、`/history` 的合并/拆分）
- Modify: `README.zh.md`（同上，如该文件维护）
- Modify: `CHANGELOG.md`（`[Unreleased]`：`Added` `/work`、`Changed` 持久化单位/`/history`、`Fixed` 标题跟 chat 跑）
- Modify: `docs/ARCHITECTURE.md`（持久化一节改成 `scopes + workSessions`）

**Step 1: 全量验证**

```bash
pnpm typecheck && pnpm test && pnpm build
```

Expected: typecheck 无输出、全部测试 PASS、build 成功。

**Step 2: 真机冒烟（在**主树**里做，不在 worktree）**

```
/release              # 加载新 dist（会 typecheck+test+build+重启）
/ctx                  # 显示工作会话 + 段，无 "会话 ID: <OMP id>" 作为身份
/history              # 同一件活一行（段数 > 1 的行展开可见各段）
/work 会话重构         # 开新工作会话，/ctx 标题 = 会话重构
/new                  # 上下文重置 → /ctx 仍是同一个工作会话、段数 +1
```
Expected: `/ctx` 的工作会话恒为 `/work` 后那一条；`/new` 之后不变；`/history` 行数 = 工作会话数。

**Step 3: Commit**

```bash
git add README.md README.zh.md CHANGELOG.md docs/ARCHITECTURE.md
git commit -m "docs: 工作会话口径与 /work 命令"
```

---

## 收尾清单

- [ ] `src/session/store.ts` 已删除，全仓无 `SessionStore` / `.sessions` 残留名（`grep -rn "SessionStore\|\.sessions\b" src` 只剩 OMP 侧词）
- [ ] `sessions.json` 已是 v2；迁移前有 `.v1.bak`
- [ ] 回填 dry-run 的输出与真机一致（4 条工作会话，`01a11d26` 带名字）
- [ ] 段级恢复、合并、拆分都有测试
- [ ] `/ctx`、`/status`、`/history`、`/resume`、`/search`、`/rename` 全部以工作会话为单位
