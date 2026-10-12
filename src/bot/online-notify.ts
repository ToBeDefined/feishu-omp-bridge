import { readFile, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { paths } from '../config/paths';

/**
 * Boot-notice marker. Written right before the process bounces
 * (`/release`, `/restart`) and read-and-cleared by the freshly booted
 * process.
 *
 * - `notify`: the requesting chat gets the 「🚀 已上线」 confirmation even
 *   without a persisted session (its entry may have been cleared by /new,
 *   /cd, /ws) — used by `/restart`, whose card cannot claim the outcome.
 * - `skip`: the requesting chat is EXCLUDED from the fan-out 「已上线」 —
 *   used by `/release`, whose progress card already ends in
 *   「🚀 已发布上线」; a second notice would be noise.
 *
 * Why the marker exists at all: the boot notification otherwise only
 * targets chats with a persisted session entry.
 */
export type OnlineNoticeMode = 'notify' | 'skip';

export async function markOnlineNotice(
  chatId: string,
  mode: OnlineNoticeMode,
  path: string = paths.onlineNotifyFile,
  messageId?: string,
): Promise<void> {
  await writeFile(path, `${JSON.stringify({ chatId, mode, messageId })}\n`, 'utf8');
}
export interface OnlineNotice {
  chatId: string;
  mode: OnlineNoticeMode;
  messageId?: string;
}

/** Drop a marker that no boot will consume (in-process reconnect, failed
 *  restart) so it cannot surface as a stale notice on a later boot. */
export async function clearOnlineNotice(path: string = paths.onlineNotifyFile): Promise<void> {
  await unlink(path).catch(() => {});
}

/** Read-and-clear the marker. Undefined when absent or corrupt — boot must
 *  never fail over a notification. */
export async function takeOnlineNotice(
  path: string = paths.onlineNotifyFile,
  legacyPath: string = paths.legacyOnlineNotifyFile,
): Promise<OnlineNotice | undefined> {
  // A bounce that deploys this rename is performed by the previous build,
  // which still writes the legacy filename. Consume it once so the first
  // boot after the upgrade is not silent; droppable once that release is out.
  for (const candidate of [path, legacyPath]) {
    let raw: string;
    try {
      raw = await readFile(candidate, 'utf8');
    } catch {
      continue;
    }
    await unlink(candidate).catch(() => {});
    try {
      const parsed = JSON.parse(raw) as { chatId?: unknown; mode?: unknown; messageId?: unknown };
      if (typeof parsed.chatId === 'string' && parsed.chatId) {
        const chatId = parsed.chatId;
        const mode = parsed.mode === 'skip' ? 'skip' : 'notify';
        const messageId = typeof parsed.messageId === 'string' ? parsed.messageId : undefined;
        return { chatId, mode, ...(messageId ? { messageId } : {}) };
      }
    } catch {
      /* corrupt marker: dropped above, keep looking */
    }
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Ordinary-boot announce throttle
//
// The generic 「🚀 已上线」 fan-out is the one notification a crash loop can
// turn into a storm: launchd `KeepAlive` + `ThrottleInterval=10` boots us every
// 10s, and each boot that gets far enough would re-announce to every chat. We
// therefore record when we last announced and stay silent within the window.
// ---------------------------------------------------------------------------

/** Default throttle window for the ordinary restart announcement. */
export const ORDINARY_BOOT_WINDOW_MS = 10 * 60 * 1000;

/** Where the last-announce timestamp lives. Kept under `appDir` — it is
 *  transient throttle state, not configuration. */
export const ORDINARY_BOOT_FILE = join(paths.appDir, 'ordinary-boot-announce.json');

/** Pure decision: is `now` still inside the silence window opened at `lastAt`?
 *  A missing/invalid `lastAt` (never announced, corrupt marker) is outside. */
export function withinAnnounceWindow(
  lastAt: number | undefined,
  now: number,
  windowMs: number,
): boolean {
  if (typeof lastAt !== 'number' || !Number.isFinite(lastAt)) return false;
  return now - lastAt < windowMs;
}

/**
 * May this boot announce the ordinary 「已上线」 fan-out? False when we
 * announced less than `windowMs` ago. When it returns true the timestamp is
 * persisted first, so a crash-loop cannot announce twice inside the window.
 *
 * Never throws: throttle state is droppable, but boot must not fail over it.
 * On a read failure we fail **open** (announce) — silence after a real restart
 * is the worse bug.
 */
export async function shouldAnnounceOrdinaryBoot(
  windowMs: number = ORDINARY_BOOT_WINDOW_MS,
  path: string = ORDINARY_BOOT_FILE,
  now: number = Date.now(),
): Promise<boolean> {
  let lastAt: number | undefined;
  try {
    const parsed = JSON.parse(await readFile(path, 'utf8')) as { at?: unknown };
    if (typeof parsed.at === 'number') lastAt = parsed.at;
  } catch {
    /* absent or corrupt → treated as "never announced" */
  }
  if (withinAnnounceWindow(lastAt, now, windowMs)) return false;
  try {
    await writeFile(path, `${JSON.stringify({ at: now })}\n`, 'utf8');
  } catch {
    /* keep the (safe) announce even if the marker can't be written */
  }
  return true;
}
