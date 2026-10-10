/**
 * 历史回填：把散落的 OMP 会话段按日志**首次绑定**归并回工作会话。
 *
 * 这个模块是纯函数、无 IO：CLI（`bridge migrate work-sessions`）负责读
 * `sessions.json`、`logs/*.log`、`omp-sessions/*.jsonl` 并喂进来。
 *
 * 历史日志里没有 `/work`（那时还没有工作会话的概念），只能拿 `/new`、`/cd`、
 * `/ws` 这些上下文切换命令当**边界代理**：一次 chat 从开张到下一次上下文重置
 * 之间那摊活，就是一条工作会话。
 */
import {
  beginWorkSession, touchSegment,
  type WorkSegment, type WorkSession,
} from './work-session';
import type { SessionsFileV2 } from './work-store';
import { log as logger } from '../core/logger';

/**
 * 日志里能用的两类事件（解析后）。
 *
 * - `bind`：chat ↔ OMP 会话的绑定（`session` / `set`、`resume`）；
 * - `boundary`：上下文重置边界（`command-reset` 且 cmd 为上下文切换类命令）。
 */
export type LogEvent =
  | { ts: number; kind: 'bind'; scope: string; sessionId: string }
  | { ts: number; kind: 'boundary'; scope: string; cmd: string };

/** 一段的最小元数据（CLI 从 `omp-sessions/*.jsonl` 的头部/mtime 取）。 */
export interface SegmentMeta {
  sessionId: string;
  cwd: string;
  startedAtMs: number;
  lastActiveAtMs: number;
}

/** 上下文重置命令 —— 只有这些是分段边界（`/resume`、`ws.cancel` 等不是）。 */
const BOUNDARY_COMMANDS: Record<string, true> = { '/new': true, '/cd': true, '/ws': true };

/** `phase ∈ {intake, command, cardAction}` 都会记 `command-reset`。 */
const RESET_PHASES: Record<string, true> = { intake: true, command: true, cardAction: true };

function parseTs(raw: unknown): number | undefined {
  if (typeof raw === 'number' && Number.isFinite(raw)) return raw;
  if (typeof raw === 'string') {
    const ms = Date.parse(raw);
    if (!Number.isNaN(ms)) return ms;
  }
  return undefined;
}

function nonEmptyString(raw: unknown): string | undefined {
  return typeof raw === 'string' && raw !== '' ? raw : undefined;
}

/**
 * 解析一行 JSON 日志为 `LogEvent`；不认识/解析失败的行一律返回 `undefined`
 * （**不抛**，日志里什么垃圾都可能有）。
 */
export function parseLogLine(line: string): LogEvent | undefined {
  let raw: unknown;
  try {
    raw = JSON.parse(line);
  } catch {
    return undefined;
  }
  if (typeof raw !== 'object' || raw === null) return undefined;
  const rec = raw as Record<string, unknown>;
  const ts = parseTs(rec['ts']);
  if (ts === undefined) return undefined;
  const phase = rec['phase'];
  const event = rec['event'];

  if (phase === 'session' && (event === 'set' || event === 'resume')) {
    // bind 的 scope 优先取日志行里显式的 `scope`（topic 群是 chatId:threadId），
    // 早期日志行没有 scope，只有随上下文自动带上的 chatId（= 裸 chat）时回退。
    const scope = nonEmptyString(rec['scope']) ?? nonEmptyString(rec['chatId']);
    const sessionId = nonEmptyString(rec['sessionId']);
    if (scope === undefined || sessionId === undefined) return undefined;
    return { ts, kind: 'bind', scope, sessionId };
  }

  if (event === 'command-reset' && typeof phase === 'string' && RESET_PHASES[phase] === true) {
    const cmd = nonEmptyString(rec['cmd']);
    // 同 bind：scope 优先，缺失时回退 chatId。
    const scope = nonEmptyString(rec['scope']) ?? nonEmptyString(rec['chatId']);
    if (cmd === undefined || scope === undefined || BOUNDARY_COMMANDS[cmd] !== true) return undefined;
    return { ts, kind: 'boundary', scope, cmd };
  }

  return undefined;
}

/**
 * 按日志回填工作会话（纯函数、幂等）。
 *
 * 规则：
 *  - 段的归属 = 它在日志里的**首次**绑定落在哪个边界区间（同一 scope 内按 ts
 *    排序计数）；`/resume` 的重复绑定不迁移、不合并。
 *  - 同一 (scope, 区间) 内的段属于同一个工作会话，id = 该区间内**首个**段的
 *    sessionId；段按 `startedAtMs` 升序并进去。
 *  - 日志里出现过、但 `segments` 里没有的 sessionId 忽略（不凭日志造段）。
 *  - `base.workSessions` 里已被认领的段不重认领、不改动。
 *  - 无日志覆盖的段 → 各自一个 `scope: null` 的工作会话（id = 段 id）。
 *  - **归属不明**的段（topic 群里裸 chatId 的 bind，见下）→ 也各自一个 `scope:
 *    null` 的工作会话，并 `logger.warn('session','backfill-scope-ambiguous',…)` 报数。
 *  - `scopes.activeWorkSession` 只在日志里**最后一次 bind** 所属工作会话存在时
 *    更新，且绝不覆盖一个仍指向存活工作会话的指针。
 *
 * 唯一副作用是那条 warn（模块本身不读盘）。
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

  // 边界按 scope 分组、按 ts 升序 —— 用来数某次绑定落在第几个区间。
  const boundaries = new Map<string, number[]>();
  for (const ev of log) {
    if (ev.kind !== 'boundary') continue;
    const list = boundaries.get(ev.scope) ?? [];
    list.push(ev.ts);
    boundaries.set(ev.scope, list);
  }
  for (const list of boundaries.values()) list.sort((a, b) => a - b);

  // 该 chatId 下存在 `chatId:<threadId>` 形式的线程边界 —— 说明它是 topic 群。
  const threadChats = new Set<string>();
  for (const scope of boundaries.keys()) {
    const colon = scope.indexOf(':');
    if (colon > 0) threadChats.add(scope.slice(0, colon));
  }

  // 每个 sessionId 的**首次**绑定（ts 升序；同 ts 保序）。
  const ordered = [...log].sort((a, b) => a.ts - b.ts);
  const firstBinding = new Map<string, { ts: number; scope: string }>();
  for (const ev of ordered) {
    if (ev.kind !== 'bind' || firstBinding.has(ev.sessionId)) continue;
    firstBinding.set(ev.sessionId, { ts: ev.ts, scope: ev.scope });
  }

  const byStart = [...segments].sort((a, b) => a.startedAtMs - b.startedAtMs);
  // 区间 → 该区间首个段的 id（= 工作会话 id）。
  const groupOwner = new Map<string, string>();
  // chatId → 无法定归属的段数（只报一次数）。
  const ambiguous = new Map<string, number>();
  for (const seg of byStart) {
    if (claimed.has(seg.sessionId)) continue;
    const seen = firstBinding.get(seg.sessionId);
    let scope: string | null = null;
    let key = `#${seg.sessionId}`;
    if (seen) {
      // topic 群里裸 chatId 的 bind 没有 thread 信息，不能猜它属于哪个线程：
      // 该段降级为 scope:null 的独立历史工作会话（仍可恢复、仍可 merge）。
      if (threadChats.has(seen.scope)) {
        ambiguous.set(seen.scope, (ambiguous.get(seen.scope) ?? 0) + 1);
      } else {
        scope = seen.scope;
        const idx = (boundaries.get(seen.scope) ?? []).filter((t) => t < seen.ts).length;
        key = `${seen.scope}#${idx}`;
      }
    }
    const ownerId = groupOwner.get(key) ?? seg.sessionId;
    groupOwner.set(key, ownerId);
    const segment: WorkSegment = { ...seg };
    const existing = workSessions[ownerId];
    workSessions[ownerId] = existing
      ? touchSegment(existing, segment, segment.lastActiveAtMs)
      : beginWorkSession(scope, segment);
    claimed.add(seg.sessionId);
  }
  for (const [chatId, count] of ambiguous) {
    logger.warn('session', 'backfill-scope-ambiguous', { chatId, count });
  }

  // 当前工作会话：日志里最后一次 bind 的那段所归属的工作会话。
  const scopes = { ...base.scopes };
  const tailBind = ordered.filter(
    (e): e is Extract<LogEvent, { kind: 'bind' }> => e.kind === 'bind',
  ).pop();
  // 归属不明的裸 chatId 不写指针（它可能根本不是真实 scope，真身是某个线程）。
  if (tailBind && !threadChats.has(tailBind.scope)) {
    const owner = Object.values(workSessions).find((ws) =>
      ws.segments.some((s) => s.sessionId === tailBind.sessionId),
    );
    const current = scopes[tailBind.scope]?.activeWorkSession;
    const currentAlive = current !== undefined && workSessions[current] !== undefined;
    if (owner && !currentAlive) {
      scopes[tailBind.scope] = { ...scopes[tailBind.scope], activeWorkSession: owner.id };
    }
  }

  return { v: 2, scopes, workSessions };
}
