import { randomBytes } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { paths } from '../config/paths';
import { log } from '../core/logger';

/**
 * Persistent, deduped, recency-ordered history of models actually used by
 * the bridge. The file stores an array newest-first (index 0 = most recent)
 * of `{ selector, at, count }`, so the /model picker can say "3 分钟前 · 5 次"
 * and not just sort by recency. Used to surface "recently used" models without
 * rescanning OMP session logs every time.
 *
 * Files written before this upgrade hold a bare `string[]` (no timestamps) and
 * are migrated in place by the first read; an upgraded file is left untouched
 * by later reads (migration is idempotent).
 */

/** 历史上限（条）。命令层也按它取全量：过滤非对话模型后仍能填满卡片的快捷区。 */
export const MAX_HISTORY_ENTRIES = 20;

export interface ModelHistoryEntry {
  /** 归一化后的 selector（无 `:thinking` 后缀，按提供方唯一）。 */
  selector: string;
  /** 最近一次使用（ms epoch）。旧 `string[]` 迁移来的条目没有时间戳 → undefined：
   * 卡片宁可不写「…前」，也不编一个时间出来。 */
  at?: number;
  /** 使用次数（>= 1）；同一条重复使用累加。 */
  count: number;
}

/**
 * 写入前归一化 selector：剥掉 `:thinking` 后缀。omp 的模型角色常写成
 * `futu/x:thinking`，消费侧（`commands/model/data.ts` 的 `commonOmpModels`）同样
 * 是 `split(':')[0]`；两边形态不统一时，「刚用过」的记录永远匹配不上选择器里的
 * 模型，去重与命中就静默失效（实测历史里确实是带后缀的原值）。
 */
function normalizeSelector(raw: string): string {
  return raw.trim().split(':')[0] ?? '';
}

/** 一条磁盘记录 → entry；形状不认识 / selector 为空的整条丢掉。 */
function parseEntry(raw: unknown): ModelHistoryEntry | undefined {
  // 旧格式：裸字符串 = 用过一次，没有时间戳。
  if (typeof raw === 'string') {
    const selector = normalizeSelector(raw);
    return selector ? { selector, count: 1 } : undefined;
  }
  if (typeof raw !== 'object' || raw === null) return undefined;
  const rec = raw as Record<string, unknown>;
  if (typeof rec.selector !== 'string') return undefined;
  const selector = normalizeSelector(rec.selector);
  if (!selector) return undefined;
  const at = typeof rec.at === 'number' && Number.isFinite(rec.at) ? rec.at : undefined;
  const count =
    typeof rec.count === 'number' && Number.isFinite(rec.count) && rec.count >= 1
      ? Math.floor(rec.count)
      : 1;
  return at === undefined ? { selector, count } : { selector, at, count };
}

/**
 * 归一化后的去重 + 截断：同一 selector 只留一条（count 相加、at 取较新）。
 * 归一化本身就会把 `futu/x` 与 `futu/x:thinking` 变成同一个 selector，所以合并
 * 必须发生在归一化之后 —— 否则升级后的文件里会并排躺着两条同义记录。
 * 保持磁盘上的先后顺序（最新在前），结果再截到上限。
 */
function normalizeEntries(entries: ModelHistoryEntry[]): ModelHistoryEntry[] {
  const merged = new Map<string, ModelHistoryEntry>();
  for (const entry of entries) {
    const prev = merged.get(entry.selector);
    if (prev === undefined) {
      merged.set(entry.selector, entry);
      continue;
    }
    const at =
      prev.at === undefined ? entry.at : entry.at === undefined ? prev.at : Math.max(prev.at, entry.at);
    merged.set(entry.selector, {
      selector: entry.selector,
      ...(at === undefined ? {} : { at }),
      count: prev.count + entry.count,
    });
  }
  return [...merged.values()].slice(0, MAX_HISTORY_ENTRIES);
}

async function readHistory(
  file: string,
): Promise<{ entries: ModelHistoryEntry[]; stale: boolean }> {
  try {
    const text = await readFile(file, 'utf8');
    const parsed = JSON.parse(text) as unknown;
    if (!Array.isArray(parsed)) return { entries: [], stale: false };
    const entries = normalizeEntries(
      parsed.map(parseEntry).filter((e): e is ModelHistoryEntry => e !== undefined),
    );
    // 与规范化后的**规范序列化**逐字比较：不等才写回。覆盖旧 `string[]`、带
    // `:thinking` 的原值、重复条目、超限文件、垃圾条目；而升级后的文件再读一次
    // 就完全相等 → 不再写（迁移幂等）。entry 只由 parseEntry / normalizeEntries /
    // recordModelUse 构造，字段顺序固定 `selector, at?, count`，比较才稳定。
    return { entries, stale: JSON.stringify(parsed) !== JSON.stringify(entries) };
  } catch {
    return { entries: [], stale: false };
  }
}

async function writeHistory(file: string, history: ModelHistoryEntry[]): Promise<void> {
  try {
    await mkdir(dirname(file), { recursive: true });
    // Unique per-call temp name: concurrent writers must not clobber each
    // other's temp before its rename.
    const tmp = `${file}.tmp-${process.pid}-${randomBytes(6).toString('hex')}`;
    await writeFile(tmp, `${JSON.stringify(history)}\n`, 'utf8');
    await rename(tmp, file);
  } catch (err) {
    log.warn('model-history', 'write-failed', { err: String(err) });
  }
}

/** Serialises history reads and writes: two concurrent read-modify-write
 * callers can't both read the same baseline and lose one update, and a
 * migration write can't clobber a use recorded while it was reading. */
let mutationChain: Promise<void> = Promise.resolve();

function serialize<T>(work: () => Promise<T>): Promise<T> {
  const result = mutationChain.then(work, work);
  mutationChain = result.then(
    () => undefined,
    () => undefined,
  );
  return result;
}

/**
 * Record a model use: normalise the selector, move it to the front, bump its
 * count, refresh its timestamp, drop duplicates, cap size.
 */
export function recordModelUse(
  model: string,
  file: string = paths.modelHistoryFile,
): Promise<void> {
  const selector = normalizeSelector(model);
  if (!selector) return Promise.resolve();
  return serialize(async () => {
    const { entries } = await readHistory(file);
    const prev = entries.find((e) => e.selector === selector);
    const next: ModelHistoryEntry[] = [
      { selector, at: Date.now(), count: (prev?.count ?? 0) + 1 },
      ...entries.filter((e) => e.selector !== selector),
    ].slice(0, MAX_HISTORY_ENTRIES);
    await writeHistory(file, next);
  });
}

/** Most recently used models, newest first, one entry per selector.
 * `at`/`count` feed the picker's「最近使用」annotation (see `RecentModel`). */
export async function recentModelEntries(
  limit = 5,
  file: string = paths.modelHistoryFile,
): Promise<ModelHistoryEntry[]> {
  return serialize(async () => {
    const { entries, stale } = await readHistory(file);
    // 升级只发生在这唯一一次读里：写回新结构，下次读就不再写（幂等）。
    if (stale) await writeHistory(file, entries);
    return entries.slice(0, limit);
  });
}
