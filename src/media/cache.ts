import { mkdir, readFile, readdir, rename, rm, stat } from 'node:fs/promises';
import { extname, join } from 'node:path';
import type { LarkChannel, ResourceDescriptor } from '@larksuiteoapi/node-sdk';
import { paths } from '../config/paths';
import { log } from '../core/logger';

export type AttachmentKind = 'image' | 'file' | 'audio' | 'video';

export interface LocalAttachment {
  path: string;
  kind: AttachmentKind;
  originalName?: string;
  /** Voice message transcript (Feishu ASR); present when transcription succeeded. */
  transcript?: string;
  /** Extracted plain text for text-like files (populated by attachTextExtracts). */
  content?: string;
}

/** File extensions whose bytes are plain text — safe to inline into the prompt. */
export const TEXT_FILE_EXTS = new Set([
  '.txt', '.md', '.markdown', '.json', '.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs',
  '.py', '.sh', '.bash', '.zsh', '.yml', '.yaml', '.toml', '.xml', '.html', '.css',
  '.scss', '.less', '.csv', '.tsv', '.log', '.env', '.gitignore', '.gitattributes',
  '.java', '.go', '.rs', '.c', '.h', '.cpp', '.hpp', '.cc', '.rb', '.php', '.sql',
  '.conf', '.ini', '.properties', '.gradle', '.kt', '.kts', '.swift', '.vue', '.svelte',
  '.diff', '.patch', '.lock', '.prisma', '.proto',
]);

const TEXT_EXTRACT_MAX = 8000;

/**
 * Inline plain-text file contents into the attachment (capped), so the agent
 * sees what the user sent without having to read the path itself. Binary /
 * unreadable files are left untouched (content stays undefined).
 */
export async function attachTextExtracts(attachments: LocalAttachment[]): Promise<void> {
  for (const a of attachments) {
    if (a.kind !== 'file' || a.content !== undefined) continue;
    const ext = extname(a.path).toLowerCase();
    if (!TEXT_FILE_EXTS.has(ext)) continue;
    try {
      const raw = await readFile(a.path, 'utf8');
      a.content =
        raw.length > TEXT_EXTRACT_MAX
          ? `${raw.slice(0, TEXT_EXTRACT_MAX)}\n…（文件内容已截断）`
          : raw;
    } catch {
      /* binary or unreadable — leave content undefined */
    }
  }
}

export interface ResourceRequest {
  messageId: string;
  resource: ResourceDescriptor;
}

export class MediaCache {
  private readonly channel: LarkChannel;

  constructor(channel: LarkChannel) {
    this.channel = channel;
  }

  async resolve(chatId: string, items: ResourceRequest[]): Promise<LocalAttachment[]> {
    if (items.length === 0) return [];
    const dir = dirFor(chatId);
    await mkdir(dir, { recursive: true });

    const results: LocalAttachment[] = [];
    for (const item of items) {
      try {
        const file = await this.resolveOne(dir, item);
        if (file) results.push(file);
      } catch (err) {
        log.fail('media', err, { fileKey: item.resource.fileKey });
      }
    }
    return results;
  }

  private async resolveOne(dir: string, item: ResourceRequest): Promise<LocalAttachment | null> {
    const { messageId, resource: r } = item;
    if (r.type === 'sticker') {
      log.info('media', 'skip', { reason: 'sticker', fileKey: r.fileKey });
      return null;
    }
    const kind: AttachmentKind = r.type;
    const fileName = pickFileName(r);
    const path = join(dir, fileName);

    try {
      await stat(path);
      log.info('media', 'cache-hit', { path });
      return { path, kind, originalName: r.fileName };
    } catch {
      /* not cached */
    }

    // The message-resource endpoint only accepts type=image|file. Audio,
    // video, and generic files must use `file` (audio/video passed through
    // verbatim → HTTP 400). Stickers are skipped above.
    const downloadType = r.type === 'image' ? 'image' : 'file';
    const result = await this.channel.rawClient.im.v1.messageResource.get({
      params: { type: downloadType },
      path: { message_id: messageId, file_key: r.fileKey },
    });
    // Write to a .part temp then rename: a mid-download network failure
    // used to leave a truncated file on disk that every later resolve
    // treated as a cache hit — corrupted images/audio served forever.
    const tmpPath = `${path}.part-${process.pid}`;
    try {
      await result.writeFile(tmpPath);
      await rename(tmpPath, path);
    } catch (err) {
      await rm(tmpPath, { force: true }).catch(() => {});
      throw err;
    }

    const size = await stat(path).then((s) => s.size).catch(() => 0);
    log.info('media', 'downloaded', { path, size });
    return { path, kind, originalName: r.fileName };
  }
}

/** Delete files under the media cache whose mtime is older than maxAgeMs. */
export async function gcMediaCache(maxAgeMs: number): Promise<void> {
  const root = paths.mediaDir;
  try {
    await stat(root);
  } catch {
    return;
  }
  const cutoff = Date.now() - maxAgeMs;
  let removed = 0;
  const chats = await readdir(root).catch(() => []);
  for (const chat of chats) {
    const dir = join(root, chat);
    const files = await readdir(dir).catch(() => []);
    for (const f of files) {
      const p = join(dir, f);
      try {
        const st = await stat(p);
        if (st.isFile() && st.mtimeMs < cutoff) {
          await rm(p);
          removed++;
        }
      } catch {
        /* skip */
      }
    }
  }
  if (removed > 0) log.info('media', 'gc', { removed });
}

function dirFor(chatId: string): string {
  const safe = chatId.replace(/[^a-zA-Z0-9_-]/g, '_');
  return join(paths.mediaDir, safe);
}

function pickFileName(r: ResourceDescriptor): string {
  // Use the full fileKey, sanitized. Feishu keys share long stable prefixes
  // (e.g. "img_v3_<bucket>_<hash>-..."), so truncating would collide across
  // different uploads from the same bucket.
  const id = r.fileKey.replace(/[^a-zA-Z0-9_-]/g, '_');
  if (r.fileName) {
    return `${id}-${sanitize(r.fileName)}`;
  }
  switch (r.type) {
    case 'image':
      return `${id}.png`;
    case 'audio':
      return `${id}.ogg`;
    case 'video':
      return `${id}.mp4`;
    default:
      return `${id}.bin`;
  }
}

function sanitize(name: string): string {
  return name.replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 80);
}
