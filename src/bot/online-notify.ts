import { readFile, unlink, writeFile } from 'node:fs/promises';
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
): Promise<void> {
  await writeFile(path, `${JSON.stringify({ chatId, mode })}\n`, 'utf8');
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
): Promise<{ chatId: string; mode: OnlineNoticeMode } | undefined> {
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
      const parsed = JSON.parse(raw) as { chatId?: unknown; mode?: unknown };
      if (typeof parsed.chatId === 'string' && parsed.chatId) {
        const chatId = parsed.chatId;
        return { chatId, mode: parsed.mode === 'skip' ? 'skip' : 'notify' };
      }
    } catch {
      /* corrupt marker: dropped above, keep looking */
    }
  }
  return undefined;
}
