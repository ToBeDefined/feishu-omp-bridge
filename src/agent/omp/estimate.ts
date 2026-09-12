import { open, readdir } from 'node:fs/promises';
import { join } from 'node:path';

/**
 * Estimate the token count an upcoming compaction has to summarize, from the
 * session JSONL's last recorded context usage.
 *
 * Compaction time is near-linear in this number (measured ≈1.0–1.4 s per
 * 1k tokens on a text-only model), so it drives both the timeout and the
 * ETA shown to the user. Byte size would mislead: `frames`/`pad` payloads
 * make 10 MB and 0.7 MB sessions cost the same.
 */
export interface SessionSizeEstimate {
  /** Last recorded context-window occupancy, in tokens (0 when unknown). */
  tokens: number;
  /** Session file size in bytes. */
  bytes: number;
}

/** Find the session file the same way the omp `--resume` scan does: flat
 * `<timestamp>_<uuid>.jsonl` entries in the session dir. */
export async function findSessionFile(
  sessionDir: string,
  sessionId: string,
): Promise<string | undefined> {
  let entries: string[];
  try {
    entries = await readdir(sessionDir);
  } catch {
    return undefined;
  }
  // The session-id frame is line 1 and omp names the file after it, but the
  // file can be resumed under a copied name — match on content like /ctx does.
  const candidate = entries
    .filter((n) => n.endsWith('.jsonl') && n.includes(sessionId))
    .sort()
    .at(-1);
  return candidate ? join(sessionDir, candidate) : undefined;
}

/**
 * Read the last assistant-message `usage` from a session file by streaming
 * from the tail: a 10 MB session gets scanned in ≤256 KB chunks instead of
 * being slurped whole into the bridge process on every /compact.
 *
 * Chunks are split on the 0x0A byte, not via UTF-8 `toString`. A CJK
 * character sitting on a 256 KB boundary would otherwise become U+FFFD,
 * JSON.parse would skip the newest usage line, and the timeout would
 * collapse to the 600 s floor.
 */
export async function estimateSessionTokens(
  sessionDir: string,
  sessionId: string,
): Promise<SessionSizeEstimate | undefined> {
  const file = await findSessionFile(sessionDir, sessionId);
  if (!file) return undefined;
  let handle;
  try {
    handle = await open(file, 'r');
  } catch {
    return undefined;
  }
  try {
    const st = await handle.stat();
    if (!st.isFile()) return undefined;
    const { size } = st;
    const CHUNK = 256 * 1024;
    let offset = size;
    // Tail fragment of a line the chunk boundary cut through; held until the
    // next (lower) chunk supplies its head. Kept as bytes so a multi-byte
    // UTF-8 sequence split across the boundary is decoded only when whole.
    let carry = Buffer.alloc(0);
    while (offset > 0) {
      const start = Math.max(0, offset - CHUNK);
      const len = offset - start;
      const buf = Buffer.allocUnsafe(len);
      await handle.read(buf, 0, len, start);
      const region = carry.length > 0 ? Buffer.concat([buf, carry]) : buf;
      const parts = splitOnNewline(region);
      carry = start > 0 ? Buffer.from(parts[0] ?? Buffer.alloc(0)) : Buffer.alloc(0);
      const complete = start > 0 ? parts.slice(1) : parts;
      for (let i = complete.length - 1; i >= 0; i--) {
        const line = complete[i];
        if (!line || line.length === 0) continue;
        const tokens = tokensFromLine(line.toString('utf8'));
        if (tokens > 0) return { tokens, bytes: size };
      }
      offset = start;
    }
    return { tokens: 0, bytes: size };
  } catch {
    return undefined;
  } finally {
    await handle.close();
  }
}

function splitOnNewline(buf: Buffer): Buffer[] {
  const parts: Buffer[] = [];
  let start = 0;
  for (let i = 0; i < buf.length; i++) {
    if (buf[i] === 0x0a) {
      parts.push(buf.subarray(start, i));
      start = i + 1;
    }
  }
  parts.push(buf.subarray(start));
  return parts;
}

/** Extract the context occupancy from one JSONL line, or 0 when the line
 * carries none. Mirrors how omp compaction budgets are reported:
 * `contextTokens ?? input + cacheRead + cacheWrite ?? totalTokens`. */
export function tokensFromLine(line: string): number {
  if (!line) return 0;
  if (!line.includes('"usage"') && !line.includes('"tokensAfter"') && !line.includes('"contextTokens"')) return 0;
  try {
    const frame = JSON.parse(line) as {
      type?: string;
      contextTokens?: number;
      tokensAfter?: number;
      message?: { role?: string; usage?: Record<string, number> };
    };
    if (frame.type === 'message' && frame.message?.role === 'assistant' && frame.message.usage) {
      const u = frame.message.usage;
      const v = u.contextTokens ?? (u.input ?? 0) + (u.cacheRead ?? 0) + (u.cacheWrite ?? 0);
      if (Number.isFinite(v) && v > 0) return v;
      const t = u.totalTokens;
      return typeof t === 'number' && Number.isFinite(t) && t > 0 ? t : 0;
    }
    // omp's own accounting frames: a previous compaction's result or a
    // context-window sample entry.
    const raw = frame.contextTokens ?? frame.tokensAfter;
    return typeof raw === 'number' && Number.isFinite(raw) && raw > 0 ? raw : 0;
  } catch {
    return 0;
  }
}

/** Measured compaction cost on a text-only model: ≈1.0–1.4 s per 1k tokens,
 * plus spawn/ready overhead. */
export function estimateCompactSeconds(tokens: number): number {
  return (tokens / 1000) * 1.35;
}

/**
 * Hard cap for a one-shot compaction: `estimate` seconds × safety, clamped.
 * The safety factor covers retry backoff and provider slowdowns — a stalled
 * run must still die rather than pin a slot forever.
 */
export function compactTimeoutMs(tokens: number, safety = 3): number {
  const seconds = Math.max(600, Math.ceil(estimateCompactSeconds(tokens) * safety));
  return Math.min(6 * 3600_000, seconds * 1000);
}
