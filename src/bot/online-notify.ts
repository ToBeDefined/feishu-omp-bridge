import { readFile, unlink, writeFile } from 'node:fs/promises';
import { paths } from '../config/paths';

/**
 * Boot-notice marker. `/release` and `/restart` write the requesting chat id
 * right before the process bounces; the freshly booted process reads-and-clears
 * it and includes that chat in the "🚀 已上线" startup notification.
 *
 * Why this exists: the boot notification otherwise only targets chats with a
 * persisted session entry — but `/new`, `/cd` and `/ws` all clear the entry, so
 * a bounce issued right after them used to restart silently and leave the user
 * thinking the bot never came back.
 */
export async function markOnlineNotify(
  chatId: string,
  path: string = paths.onlineNotifyFile,
): Promise<void> {
  await writeFile(path, `${JSON.stringify({ chatId })}\n`, 'utf8');
}

/** Drop a marker that no boot will consume (in-process reconnect, failed
 *  restart) so it cannot surface as a stale "已上线" on a later boot. */
export async function clearOnlineNotify(path: string = paths.onlineNotifyFile): Promise<void> {
  await unlink(path).catch(() => {});
}

/** Read-and-clear the marker. Undefined when absent or corrupt — boot must
 *  never fail over a notification. */
export async function takeOnlineNotify(
  path: string = paths.onlineNotifyFile,
  legacyPath: string = paths.legacyOnlineNotifyFile,
): Promise<string | undefined> {
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
      const parsed = JSON.parse(raw) as { chatId?: unknown };
      if (typeof parsed.chatId === 'string' && parsed.chatId) return parsed.chatId;
    } catch {
      /* corrupt marker: dropped above, keep looking */
    }
  }
  return undefined;
}
