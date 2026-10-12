import { randomBytes } from 'node:crypto';
import {
  closeSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
  writeSync,
} from 'node:fs';
import { mkdir, readdir, rename, stat, unlink, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { paths } from '../config/paths';
import type { TenantBrand } from '../config/schema';

/**
 * Tracks running `feishu-omp-bridge start` processes so we can:
 *   - Warn on duplicate `start` of the same app (open-platform routes events
 *     to one of N long-connections randomly, leaving users guessing).
 *   - Let users list (`ps` / `/ps`) and terminate (`stop <id>` / `/exit <id>`)
 *     a specific process.
 *
 * Single-machine only — entries live in a local JSON file and processes are
 * identified by OS PID. PIDs may go stale (kill -9, crash, OS reboot); every
 * read prunes entries whose PID is not alive (`process.kill(pid, 0)` throws
 * ESRCH for dead PIDs). The file is rewritten atomically (temp + rename) to
 * avoid partial reads during concurrent updates.
 */

export interface ProcessEntry {
  /** 4-char random hex, stable for this process's lifetime. */
  id: string;
  pid: number;
  appId: string;
  tenant: TenantBrand;
  configPath: string;
  startedAt: string;
  version: string;
  /** Bot's display name (e.g. "尼莫"). Filled in by startChannel after the
   * WS handshake — undefined until the connection is up, or on processes
   * registered by older versions of the bridge. */
  botName?: string;
}

interface RegistryFile {
  entries: ProcessEntry[];
}

function readRaw(path: string): RegistryFile {
  try {
    const text = readFileSync(path, 'utf8');
    const parsed = JSON.parse(text) as Partial<RegistryFile>;
    if (!parsed || !Array.isArray(parsed.entries)) return { entries: [] };
    return { entries: parsed.entries.filter(isValidEntry) };
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return { entries: [] };
    return { entries: [] };
  }
}

function isValidEntry(e: unknown): e is ProcessEntry {
  if (!e || typeof e !== 'object') return false;
  const x = e as Record<string, unknown>;
  return (
    typeof x.id === 'string' &&
    typeof x.pid === 'number' &&
    typeof x.appId === 'string' &&
    (x.tenant === 'feishu' || x.tenant === 'lark') &&
    typeof x.configPath === 'string' &&
    typeof x.startedAt === 'string' &&
    typeof x.version === 'string'
  );
}

export function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/**
 * Read the registry, dropping entries whose PID is no longer alive. The
 * pruned-back state is **not** persisted here — callers that mutate write
 * the full new state via `writeAtomic`. (Read-only callers like /ps don't
 * need to bother persisting the prune.)
 */
export function readAndPrune(path: string = paths.processesFile): ProcessEntry[] {
  const raw = readRaw(path);
  return raw.entries.filter((e) => isAlive(e.pid));
}

async function writeAtomic(entries: ProcessEntry[], path: string): Promise<void> {
  // Unique per-call temp name: two concurrent writers must not clobber each
  // other's temp before its rename.
  const tmp = `${path}.tmp-${process.pid}-${randomBytes(6).toString('hex')}`;
  const body = `${JSON.stringify({ entries } satisfies RegistryFile, null, 2)}\n`;
  await mkdir(dirname(path), { recursive: true });
  await writeFile(tmp, body, 'utf8');
  await rename(tmp, path);
}

function writeAtomicSync(entries: ProcessEntry[], path: string): void {
  const tmp = `${path}.tmp-${process.pid}`;
  const body = `${JSON.stringify({ entries } satisfies RegistryFile, null, 2)}\n`;
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(tmp, body, 'utf8');
  renameSync(tmp, path);
}

// ---------------------------------------------------------------------------
// Cross-process lock
//
// The in-process `mutationChain` below only serialises callers inside one
// process. Two `start` processes still read-modify-write the same registry
// file: both prune, both write the full entry list, last rename wins and the
// other's entry vanishes — `sameAppOthers` then can't see the twin and we get
// two long-connections on the same app. Every mutation therefore wraps its
// read-modify-write in `<file>.lock`, created with O_EXCL:
//   - busy  → retry every `retryMs` up to `timeoutMs`, then fail loudly
//     (refusing to write unlocked is the point; a dropped entry is the bug).
//   - stale → a lock whose mtime is older than `staleMs` means the holder
//     died before unlinking (kill -9, power loss); take it over. Takeover
//     renames the stale file away instead of unlinking, so two processes that
//     both spotted the stale lock can't evict the fresh lock of the winner.
// ---------------------------------------------------------------------------

const LOCK_RETRY_MS = 50;
const LOCK_TIMEOUT_MS = 2_000;
const LOCK_STALE_MS = 5_000;

export interface RegistryLockOptions {
  /** Poll interval while the lock is held by someone else. */
  retryMs?: number;
  /** Give up (throw) after this long without acquiring. */
  timeoutMs?: number;
  /** Lock file mtime older than this ⇒ holder crashed ⇒ take over. */
  staleMs?: number;
}

/** One O_EXCL acquisition attempt. On EEXIST, checks for a stale lock and if
 * stale, moves it aside (atomic — only one contender can rename it) so the
 * next attempt can create its own. Returns whether we hold the lock now. */
function tryAcquireSync(lockPath: string, staleMs: number): boolean {
  let fd: number;
  try {
    fd = openSync(lockPath, 'wx');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
    let mtimeMs: number;
    try {
      mtimeMs = statSync(lockPath).mtimeMs;
    } catch {
      return false; // released between create-attempt and stat; just retry
    }
    if (Date.now() - mtimeMs <= staleMs) return false;
    try {
      renameSync(lockPath, `${lockPath}.stale`);
      try {
        unlinkSync(`${lockPath}.stale`);
      } catch {
        /* another takeover already swept it */
      }
    } catch {
      /* someone else took it over; fall through and retry */
    }
    return false;
  }
  try {
    writeSync(fd, `${process.pid}\n`);
  } finally {
    closeSync(fd);
  }
  return true;
}

/**
 * Run `fn` while holding the cross-process registry lock for `file`.
 * All registry mutations go through this; `fn` must not return before it is
 * safe for another process to mutate (no leaking of in-flight work).
 */
export async function withRegistryLock<T>(
  file: string,
  fn: () => Promise<T>,
  options: RegistryLockOptions = {},
): Promise<T> {
  const retryMs = options.retryMs ?? LOCK_RETRY_MS;
  const timeoutMs = options.timeoutMs ?? LOCK_TIMEOUT_MS;
  const staleMs = options.staleMs ?? LOCK_STALE_MS;
  const lockPath = `${file}.lock`;
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (tryAcquireSync(lockPath, staleMs)) break;
    if (Date.now() >= deadline) {
      throw new Error(`registry lock busy after ${timeoutMs}ms: ${lockPath}`);
    }
    // Executor form: Promise.withResolvers needs Node 22+ / ES2024 lib; this
    // package still supports Node >= 20 (same as bot/active-runs.ts).
    await new Promise((resolve) => setTimeout(resolve, retryMs));
  }
  try {
    return await fn();
  } finally {
    try {
      unlinkSync(lockPath);
    } catch {
      /* a stale-takeover may have moved it; nothing to release */
    }
  }
}

/** Generate a short, human-typable id. Collisions are caller's problem;
 * acceptable since dead entries are pruned and same-machine fleets are
 * small. */
export function generateShortId(): string {
  return randomBytes(2).toString('hex');
}

export interface RegisterArgs {
  appId: string;
  tenant: TenantBrand;
  configPath: string;
  version: string;
}

/** Serialises registry mutations *within this process* so two concurrent
 * read-modify-write callers can't both read the same baseline and lose one
 * update. Cross-process safety comes from `withRegistryLock`, which every
 * mutation additionally takes — this chain just avoids lock busy-waiting
 * between our own coroutines. */
let mutationChain: Promise<void> = Promise.resolve();

function enqueue<T>(fn: () => Promise<T>): Promise<T> {
  const result = mutationChain.then(fn, fn);
  mutationChain = result.then(
    () => undefined,
    () => undefined,
  );
  return result;
}

/**
 * Atomically prune + add this process to the registry. Returns the entry
 * representing this process (so callers can stash the id for later use, e.g.
 * "is /exit <id> me?" checks).
 *
 * The read-modify-write runs under the cross-process `<file>.lock` (on top of
 * the in-process chain) — two concurrent `start` processes must not clobber
 * each other's entry.
 *
 * Caller is responsible for installing cleanup that calls `unregister`.
 */
export function register(
  args: RegisterArgs,
  file: string = paths.processesFile,
): Promise<ProcessEntry> {
  return enqueue(() =>
    withRegistryLock(file, async () => {
      const live = readAndPrune(file);
      const entry: ProcessEntry = {
        id: generateShortId(),
        pid: process.pid,
        appId: args.appId,
        tenant: args.tenant,
        configPath: args.configPath,
        startedAt: new Date().toISOString(),
        version: args.version,
      };
      await writeAtomic([...live, entry], file);
      return entry;
    }),
  );
}

/** Remove an entry by id. Lock + atomic + prunes dead in same write. Async. */
export function unregister(id: string, file: string = paths.processesFile): Promise<void> {
  return enqueue(() =>
    withRegistryLock(file, async () => {
      const live = readAndPrune(file);
      const next = live.filter((e) => e.id !== id);
      if (next.length === live.length) return;
      await writeAtomic(next, file);
    }),
  );
}

/**
 * Replace mutable fields on the entry identified by `id`. Used after
 * /account change so `ps` reflects the current credentials. No-op when the
 * entry has already been pruned out.
 */
export function updateEntry(
  id: string,
  patch: Partial<Pick<ProcessEntry, 'appId' | 'tenant' | 'configPath' | 'botName'>>,
  file: string = paths.processesFile,
): Promise<void> {
  return enqueue(() =>
    withRegistryLock(file, async () => {
      const live = readAndPrune(file);
      let changed = false;
      const next = live.map((e) => {
        if (e.id !== id) return e;
        changed = true;
        return { ...e, ...patch };
      });
      if (!changed) return;
      await writeAtomic(next, file);
    }),
  );
}

/**
 * Synchronous unregister — for use inside `process.on('exit')` and other
 * sync-only contexts where async file I/O doesn't run. Best-effort: if
 * another process holds the lock we skip the write entirely (this process is
 * exiting; its dead pid gets pruned on the next read anyway) and if the lock
 * is stale we take it over, same as the async path.
 */
export function unregisterSync(id: string, file: string = paths.processesFile): void {
  const lockPath = `${file}.lock`;
  try {
    if (!tryAcquireSync(lockPath, LOCK_STALE_MS)) return;
    try {
      const live = readRaw(file).entries.filter((e) => isAlive(e.pid));
      const next = live.filter((e) => e.id !== id);
      if (next.length === live.length) return;
      writeAtomicSync(next, file);
    } finally {
      try {
        unlinkSync(lockPath);
      } catch {
        /* a stale-takeover may have moved it; nothing to release */
      }
    }
  } catch {
    // exit handlers must not throw.
  }
}

// ---------------------------------------------------------------------------
// Temp-file hygiene
//
// Our atomic writers (registry, config, keystore, running-cards, scheduler)
// all `writeFile(<target>.tmp-…); rename(…)`. A crash between the two leaves
// the temp behind, and because names embed pid + random hex it is never
// reused — so the leak is monotonic (the real "tmp 垃圾累积" incident).
//
// Two shapes exist:
//   <target>.tmp-<pid>[-<hex>]   registry/config/keystore/scheduler async writes
//   <target>.<pid>.tmp           card/managed running-cards
// ---------------------------------------------------------------------------

/** Matches both temp-file shapes above (and their bare `.tmp` prefix form). */
const TMP_NAME_RE = /\.tmp(-.*)?$/;

/**
 * Delete `*.tmp` / `*.tmp-*` files in `dir` whose mtime is older than
 * `maxAgeMs`, returning how many were removed. Best-effort: a missing dir or
 * an un-stattable/un-unlinkable file is skipped, never thrown — this runs on
 * the boot path where a failure must not cascade into the 10s launchd retry
 * loop. The age gate keeps us from trashing a live writer's in-flight temp.
 */
export async function sweepStaleTmpFiles(dir: string, maxAgeMs: number): Promise<number> {
  let names: string[];
  try {
    names = await readdir(dir);
  } catch {
    return 0;
  }
  const cutoff = Date.now() - maxAgeMs;
  let removed = 0;
  for (const name of names) {
    if (!TMP_NAME_RE.test(name)) continue;
    const full = join(dir, name);
    try {
      const info = await stat(full);
      if (info.mtimeMs > cutoff) continue;
      await unlink(full);
      removed += 1;
    } catch {
      /* vanished under us (another sweeper / the writer finished) — fine */
    }
  }
  return removed;
}

/**
 * Best-effort: unlink the temp files **this process** wrote. Called from
 * `process.on('exit')`, so it stays synchronous.
 *
 * The old version unlinked exactly `<processesFile>.tmp-<pid>` — a name no
 * writer ever produced once pid+hex suffixes were added — so it matched
 * nothing and every unclean exit leaked its temp. Sweep the app dir by
 * pattern instead, but only our own pid: another live process may be
 * mid-rename on its own temp.
 */
export function cleanupTmpFiles(dir: string = paths.appDir): void {
  const pid = process.pid;
  try {
    for (const name of readdirSync(dir)) {
      // Only our own pid's temps: `.tmp-<pid>-…`, `.tmp-<pid>`, `.<pid>.tmp`.
      const ours =
        TMP_NAME_RE.test(name) &&
        (name.includes(`.tmp-${pid}-`) || name.endsWith(`.tmp-${pid}`) || name.endsWith(`.${pid}.tmp`));
      if (!ours) continue;
      try {
        unlinkSync(join(dir, name));
      } catch {
        /* ignore */
      }
    }
  } catch {
    /* ignore */
  }
}

/**
 * Find living entries with the same appId, excluding `excludePid` (typically
 * the caller's own pid) so a process doesn't flag itself as a conflict.
 */
export function sameAppOthers(
  appId: string,
  excludePid = process.pid,
  path: string = paths.processesFile,
): ProcessEntry[] {
  return readAndPrune(path).filter((e) => e.appId === appId && e.pid !== excludePid);
}

/**
 * Resolve `target` (short id OR 1-based index in the current `ps` view) to
 * an entry. Index lookup uses the same prune order as `readAndPrune()`.
 */
export function resolveTarget(
  target: string,
  path: string = paths.processesFile,
): ProcessEntry | undefined {
  const live = readAndPrune(path);
  const byId = live.find((e) => e.id === target);
  if (byId) return byId;
  // Only a pure-digit target is an index; otherwise a typo like `3f2` would
  // silently resolve to entry 3 and stop the wrong process.
  if (/^\d+$/.test(target)) {
    const n = Number.parseInt(target, 10);
    if (n >= 1 && n <= live.length) return live[n - 1];
  }
  return undefined;
}
