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

async function readHistory(): Promise<string[]> {
  try {
    const text = await readFile(paths.modelHistoryFile, 'utf8');
    const parsed = JSON.parse(text) as unknown;
    if (Array.isArray(parsed)) {
      return parsed.filter((m): m is string => typeof m === 'string');
    }
    return [];
  } catch {
    return [];
  }
}

async function writeHistory(history: string[]): Promise<void> {
  try {
    await mkdir(dirname(paths.modelHistoryFile), { recursive: true });
    const tmp = `${paths.modelHistoryFile}.tmp-${process.pid}`;
    await writeFile(tmp, `${JSON.stringify(history)}\n`, 'utf8');
    await rename(tmp, paths.modelHistoryFile);
  } catch (err) {
    log.warn('model-history', 'write-failed', { err: String(err) });
  }
}

/** Record a model use: move it to the front, drop duplicates, cap size. */
export async function recordModelUse(model: string): Promise<void> {
  if (!model) return;
  const history = await readHistory();
  const next = [model, ...history.filter((m) => m !== model)].slice(0, MAX_ENTRIES);
  await writeHistory(next);
}

/** Return the most recently used models, newest first, deduped. */
export async function recentModels(limit = 5): Promise<string[]> {
  const history = await readHistory();
  return history.slice(0, limit);
}
