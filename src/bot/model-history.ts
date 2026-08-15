import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { paths } from '../config/paths';
import { log } from '../core/logger';

/**
 * Persistent, deduped, recency-ordered history of models actually used by
 * the bridge. The file stores an array newest-first (index 0 = most recent).
 * Used to surface "recently used" models in the /model picker without
 * rescanning OMP session logs every time.
 */

const MAX_ENTRIES = 20;

async function readHistory(file: string): Promise<string[]> {
  try {
    const text = await readFile(file, 'utf8');
    const parsed = JSON.parse(text) as unknown;
    if (Array.isArray(parsed)) {
      return parsed.filter((m): m is string => typeof m === 'string');
    }
    return [];
  } catch {
    return [];
  }
}

async function writeHistory(file: string, history: string[]): Promise<void> {
  try {
    await mkdir(dirname(file), { recursive: true });
    const tmp = `${file}.tmp-${process.pid}`;
    await writeFile(tmp, `${JSON.stringify(history)}\n`, 'utf8');
    await rename(tmp, file);
  } catch (err) {
    log.warn('model-history', 'write-failed', { err: String(err) });
  }
}

/** Record a model use: move it to the front, drop duplicates, cap size. */
export async function recordModelUse(
  model: string,
  file: string = paths.modelHistoryFile,
): Promise<void> {
  if (!model || !model.trim()) return;
  const history = await readHistory(file);
  const next = [model, ...history.filter((m) => m !== model)].slice(0, MAX_ENTRIES);
  await writeHistory(file, next);
}

/** Return the most recently used models, newest first, deduped. */
export async function recentModels(
  limit = 5,
  file: string = paths.modelHistoryFile,
): Promise<string[]> {
  const history = await readHistory(file);
  return history.slice(0, limit);
}
