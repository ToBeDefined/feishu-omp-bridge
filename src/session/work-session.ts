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
