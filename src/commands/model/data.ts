import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { paths } from '../../config/paths';
import { getOmpBinary } from '../../config/schema';
import type { AppConfig } from '../../config/schema';
import { log } from '../../core/logger';

export interface OmpModelEntry {
  provider: string;
  selector: string;
  name?: string;
}

const execFileAsync = promisify(execFile);

/** Read the configured modelRoles (per-role models in ~/.omp config) and
 * return the distinct model selectors, newest-first as authored. The
 * `default` role often carries a `:thinking` suffix, which is stripped. */
export async function commonOmpModels(cfg: AppConfig): Promise<string[]> {
  const omp = getOmpBinary(cfg);
  try {
    const { stdout } = await execFileAsync(omp, ['config', 'get', 'modelRoles', '--json'], {
      encoding: 'utf8',
      env: { ...process.env },
    });
    const parsed = JSON.parse(stdout) as { value?: Record<string, string> };
    const seen = new Set<string>();
    const out: string[] = [];
    for (const role of Object.keys(parsed.value ?? {})) {
      const raw = parsed.value?.[role] ?? '';
      const sel = raw.split(':')[0] ?? '';
      if (!sel || !sel.includes('/')) continue;
      if (seen.has(sel)) continue;
      seen.add(sel);
      out.push(sel);
    }
    return out;
  } catch (err) {
    log.warn('command', 'common-models-failed', { err: String(err) });
    return [];
  }
}

export async function listOmpModels(cfg: AppConfig): Promise<OmpModelEntry[]> {
  const omp = getOmpBinary(cfg);
  try {
    const { stdout } = await execFileAsync(omp, ['models', '--json'], {
      encoding: 'utf8',
      env: { ...process.env },
      maxBuffer: 4 * 1024 * 1024,
    });
    const parsed = JSON.parse(stdout) as { models?: OmpModelEntry[] };
    return parsed.models ?? [];
  } catch (err) {
    log.warn('command', 'model-list-failed', { err: String(err) });
    return [];
  }
}

/** Cache entry on disk: both the full model list and the configured common
 * models, refreshed together. */
export interface ModelsCache {
  fetchedAt: number;
  list: OmpModelEntry[];
  commons: string[];
}

const MODEL_CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

async function loadModelsCache(): Promise<ModelsCache | undefined> {
  try {
    const text = await readFile(paths.modelsCacheFile, 'utf8');
    const parsed = JSON.parse(text) as ModelsCache;
    if (typeof parsed.fetchedAt !== 'number' || !Array.isArray(parsed.list)) return undefined;
    return parsed;
  } catch {
    return undefined;
  }
}

async function saveModelsCache(cache: ModelsCache): Promise<void> {
  try {
    await mkdir(dirname(paths.modelsCacheFile), { recursive: true });
    const tmp = `${paths.modelsCacheFile}.tmp-${process.pid}`;
    await writeFile(tmp, `${JSON.stringify(cache)}\n`, 'utf8');
    await rename(tmp, paths.modelsCacheFile);
  } catch (err) {
    log.warn('command', 'models-cache-write-failed', { err: String(err) });
  }
}

/** Load the model list and common models, using the 7-day disk cache unless
 * `force` requests a refresh (which rewrites the cache). */
export async function loadModelData(cfg: AppConfig, force: boolean): Promise<ModelsCache> {
  if (!force) {
    const cached = await loadModelsCache();
    if (cached && Date.now() - cached.fetchedAt < MODEL_CACHE_TTL_MS) return cached;
  }
  const [list, commons] = await Promise.all([listOmpModels(cfg), commonOmpModels(cfg)]);
  const fresh: ModelsCache = { fetchedAt: Date.now(), list, commons };
  await saveModelsCache(fresh);
  return fresh;
}
