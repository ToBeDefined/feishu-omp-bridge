import { readFile, unlink, writeFile } from 'node:fs/promises';
import { paths } from '../config/paths';

/**
 * Release online-marker. `/release` writes the requesting chat id right
 * before the process bounces; the freshly booted process reads-and-clears
 * it and includes that chat in the "已上线" startup notification.
 *
 * Why this exists: the boot notification otherwise only targets chats with
 * a persisted session entry — but `/new`, `/cd`, `/ws` all clear the entry,
 * so a release issued right after them used to restart silently and leave
 * the user thinking the bot never came back.
 */
export async function markReleaseOnline(
  chatId: string,
  path: string = paths.releaseNotifyFile,
): Promise<void> {
  await writeFile(path, `${JSON.stringify({ chatId })}\n`, 'utf8');
}

/** Read-and-clear the marker. Undefined when absent or corrupt — boot must
 *  never fail over a notification. */
export async function takeReleaseOnline(
  path: string = paths.releaseNotifyFile,
): Promise<string | undefined> {
  let raw: string;
  try {
    raw = await readFile(path, 'utf8');
  } catch {
    return undefined;
  }
  await unlink(path).catch(() => {});
  try {
    const parsed = JSON.parse(raw) as { chatId?: unknown };
    return typeof parsed.chatId === 'string' && parsed.chatId ? parsed.chatId : undefined;
  } catch {
    return undefined;
  }
}
