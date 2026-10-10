import { readdir, readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { getOmpSessionDir } from '../../config/schema';
import type { CommandContext } from '../index';
import { sampleSegmentId, scanSessionFile } from './context';

/**
 * One session JSONL on disk, as both /resume (picker) and /history (ledger)
 * need it. Owns the "read every session file once" pass so neither command
 * grows its own scanner.
 */
export interface SessionRecord {
  sessionId: string;
  /** Directory the session was created in — the only cwd it can resume from. */
  cwd: string;
  /** Session start, ISO. Falls back to the file name's timestamp prefix. */
  startedAt: string;
  /** Last write of the JSONL = last activity. The /history sort key. */
  updatedAtMs: number;
  /** Real user turns (bridge_context stripped). */
  turns: number;
  /** User-assigned title (/rename), when one exists. */
  title?: string;
  /** Last assistant text reply — the auto summary. */
  summary?: string;
  /** Last real user message. */
  lastMessage?: string;
}

/**
 * 段（OMP 会话 id）→ 工作会话名字。等价于旧 `titlesBySessionId()`：只收有名字
 * 的工作会话，把它每个段都映射到该名字（Task 10 才会改成工作会话口径）。
 */
export function titlesBySegment(ctx: CommandContext): Record<string, string> {
  const out: Record<string, string> = {};
  for (const ws of ctx.workSessions.allWorkSessions()) {
    if (ws.title === undefined) continue;
    for (const seg of ws.segments) out[seg.sessionId] = ws.title;
  }
  return out;
}

/**
 * Every session JSONL in the OMP session dir, NEWEST ACTIVITY FIRST.
 *
 * Reads each file's JSONL once and stats it for the activity time; files
 * whose header is unreadable (or lacks an id/cwd) are skipped rather than
 * failing the listing. This is the raw per-OMP-session view: /resume's picker
 * still lists one row per OMP session (Task 9 reworks that); /history is the
 * caller that wants the work-session view — see `listWorkSessions`.
 */
export async function scanSessionFiles(ctx: CommandContext): Promise<SessionRecord[]> {
  const dir = getOmpSessionDir(ctx.controls.cfg);
  const titles = titlesBySegment(ctx);
  let names: string[];
  try {
    names = (await readdir(dir)).filter((n) => n.endsWith('.jsonl'));
  } catch {
    return [];
  }
  const out: SessionRecord[] = [];
  for (const name of names) {
    const path = join(dir, name);
    try {
      const [text, info] = await Promise.all([readFile(path, 'utf8'), stat(path)]);
      const { meta, lastAssistant, lastUserMessage, turns } = scanSessionFile(text);
      if (!meta?.id || !meta.cwd) continue;
      const title = titles[meta.id];
      out.push({
        sessionId: meta.id,
        cwd: meta.cwd,
        startedAt: meta.timestamp ?? name,
        updatedAtMs: info.mtimeMs,
        turns,
        ...(title !== undefined ? { title } : {}),
        ...(lastAssistant ? { summary: lastAssistant } : {}),
        ...(lastUserMessage ? { lastMessage: lastUserMessage } : {}),
      });
    } catch {
      continue;
    }
  }
  out.sort((a, b) => b.updatedAtMs - a.updatedAtMs);
  return out;
}

/** One segment of a work session that still exists on disk. */
export interface WorkSessionSegmentStat {
  sessionId: string;
  /** Real user turns in this segment's file. */
  turns: number;
  /** mtime of this segment's file. */
  updatedAtMs: number;
  /** Last real user message of this segment. */
  lastMessage?: string;
}

/**
 * One `/history` row = one WORK session (Task 8). Aggregates the on-disk
 * stats of every segment the work session still has, so a 3-segment work
 * session collapses into a single ledger row.
 */
export interface WorkSessionRecord {
  /** Work session id (first segment's OMP id; orphan files use their own id). */
  workSessionId: string;
  /** Work session name (/rename). */
  title?: string;
  /** Last user message of the current/latest segment — the display fallback. */
  topic?: string;
  /**
   * `ws.segments.length`: the work session's declared segment count, INCLUDING
   * segments whose file has since been deleted (those still count here). Use
   * `segments.length` if you only want the ones still on disk.
   */
  segmentCount: number;
  /** Σ turns over segments still on disk (deleted segments contribute 0). */
  turns: number;
  /** Work session cwd (its latest segment's cwd). */
  cwd: string;
  /** max(ws.lastActiveAtMs, every surviving segment file's mtime). */
  lastActiveAtMs: number;
  /** Owning scope; `null` for a file no work session claims. */
  scope: string | null;
  /** Segments whose file is still on disk, in work-session order. */
  segments: WorkSessionSegmentStat[];
}

/**
 * Every past conversation as `/history` sees it: one row per work session,
 * NEWEST ACTIVITY FIRST.
 *
 * Scans the session dir once, then folds each work session's segments into a
 * single record (`turns`/topic/mtime summed or taken from the surviving
 * segments). A file no work session claims becomes its own row —
 * `workSessionId` = its session id, `scope: null` — so old/unclaimed history
 * stays visible (and resumable). A segment whose file was deleted is not
 * dropped from `segmentCount`, but contributes no turns.
 */
export async function listWorkSessions(ctx: CommandContext): Promise<WorkSessionRecord[]> {
  const files = await scanSessionFiles(ctx);
  const byId = new Map(files.map((f) => [f.sessionId, f]));
  const claimed = new Set<string>();
  const rows: WorkSessionRecord[] = [];

  for (const ws of ctx.workSessions.allWorkSessions()) {
    const segments: WorkSessionSegmentStat[] = [];
    for (const seg of ws.segments) {
      const rec = byId.get(seg.sessionId);
      if (!rec) continue;
      segments.push({
        sessionId: seg.sessionId,
        turns: rec.turns,
        updatedAtMs: rec.updatedAtMs,
        ...(rec.lastMessage ? { lastMessage: rec.lastMessage } : {}),
      });
      claimed.add(seg.sessionId);
    }
    // Display fallback is deliberately the CURRENT (else latest) segment only,
    // matching /ctx, /rename and /new: scanning older segments to find a
    // message would be O(dir) per work session.
    const sampleId = sampleSegmentId(ws);
    const topic = segments.find((s) => s.sessionId === sampleId)?.lastMessage;
    rows.push({
      workSessionId: ws.id,
      ...(ws.title !== undefined ? { title: ws.title } : {}),
      ...(topic !== undefined ? { topic } : {}),
      segmentCount: ws.segments.length,
      turns: segments.reduce((n, s) => n + s.turns, 0),
      cwd: ws.cwd,
      lastActiveAtMs: Math.max(ws.lastActiveAtMs, 0, ...segments.map((s) => s.updatedAtMs)),
      scope: ws.scope,
      segments,
    });
  }

  // Files no work session claims (old history, or pre-backfill): their own row.
  for (const f of files) {
    if (claimed.has(f.sessionId)) continue;
    rows.push({
      workSessionId: f.sessionId,
      ...(f.lastMessage ? { topic: f.lastMessage } : {}),
      segmentCount: 1,
      turns: f.turns,
      cwd: f.cwd,
      lastActiveAtMs: f.updatedAtMs,
      scope: null,
      segments: [
        {
          sessionId: f.sessionId,
          turns: f.turns,
          updatedAtMs: f.updatedAtMs,
          ...(f.lastMessage ? { lastMessage: f.lastMessage } : {}),
        },
      ],
    });
  }

  rows.sort((a, b) => b.lastActiveAtMs - a.lastActiveAtMs);
  return rows;
}
