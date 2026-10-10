import { readdir, readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { getOmpSessionDir } from '../../config/schema';
import type { CommandContext } from '../index';
import { scanSessionFile } from './context';

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
 * Every session file in the OMP session dir, NEWEST ACTIVITY FIRST.
 *
 * Reads each file's JSONL once and stats it for the activity time; files
 * whose header is unreadable (or lacks an id/cwd) are skipped rather than
 * failing the listing.
 */
export async function listSessions(ctx: CommandContext): Promise<SessionRecord[]> {
  const dir = getOmpSessionDir(ctx.controls.cfg);
  const titles = ctx.sessions.titlesBySessionId();
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
