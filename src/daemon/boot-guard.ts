import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { paths } from '../config/paths';

/**
 * Boot circuit breaker.
 *
 * launchd runs us with `KeepAlive=true` + `ThrottleInterval=10`: any boot that
 * fails (exit != 0) is retried every 10 seconds, forever. A prerequisite that
 * is missing for hours (bad config, dead omp binary, a conflicting instance)
 * therefore turns into a subsequence of doomed boot attempts that, before the
 * boot path was made cheap, dragged the whole machine to load 38.
 *
 * We count recent failures here. Once too many land inside a window the daemon
 * treats itself as "auto-restart exhausted": it does no heavy work, tries to
 * tell the user, and unloads itself from launchd so the retry loop stops.
 *
 * State lives in `boot-attempts.json`; a corrupt/missing file is read as an
 * empty state (the breaker is a safety net, never a boot blocker).
 */
export const BOOT_ATTEMPTS_FILE = join(paths.appDir, 'boot-attempts.json');

export interface BootFailure {
  /** ISO timestamp of the failed attempt. */
  at: string;
  reason: string;
}

export interface BootAttemptsState {
  failures: BootFailure[];
  lastSuccessAt: string | null;
}

export const DEFAULT_BOOT_THRESHOLD = 5;
export const DEFAULT_BOOT_WINDOW_MS = 10 * 60 * 1000;

/**
 * Pure decision used by both production and tests: are there at least
 * `threshold` failures inside the trailing `windowMs` before `now`?
 */
export function shouldTrip(
  failures: BootFailure[],
  now: number,
  opts: { threshold?: number; windowMs?: number } = {},
): boolean {
  const threshold = opts.threshold ?? DEFAULT_BOOT_THRESHOLD;
  const windowMs = opts.windowMs ?? DEFAULT_BOOT_WINDOW_MS;
  const cutoff = now - windowMs;
  let count = 0;
  for (const f of failures) {
    const t = Date.parse(f.at);
    if (Number.isFinite(t) && t >= cutoff) count += 1;
  }
  return count >= threshold;
}

/** Drop failures outside the window (and any with an unparseable timestamp). */
function prune(failures: BootFailure[], now: number, windowMs: number): BootFailure[] {
  const cutoff = now - windowMs;
  return failures.filter((f) => {
    const t = Date.parse(f.at);
    return Number.isFinite(t) && t >= cutoff;
  });
}

/** Read + sanitize the state file. Corrupt/missing → empty state. */
async function readState(file: string): Promise<BootAttemptsState> {
  let raw: string;
  try {
    raw = await readFile(file, 'utf8');
  } catch {
    return { failures: [], lastSuccessAt: null };
  }
  try {
    const parsed = JSON.parse(raw) as Partial<BootAttemptsState>;
    const failures = Array.isArray(parsed.failures)
      ? parsed.failures.filter(
          (f): f is BootFailure =>
            !!f &&
            typeof (f as BootFailure).at === 'string' &&
            typeof (f as BootFailure).reason === 'string',
        )
      : [];
    const lastSuccessAt = typeof parsed.lastSuccessAt === 'string' ? parsed.lastSuccessAt : null;
    return { failures, lastSuccessAt };
  } catch {
    return { failures: [], lastSuccessAt: null };
  }
}

/** Atomic write: tmp file + rename so a crash mid-write can't leave a partial. */
async function writeState(state: BootAttemptsState, file: string): Promise<void> {
  await mkdir(dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}-${Date.now()}`;
  await writeFile(tmp, `${JSON.stringify(state)}\n`, 'utf8');
  await rename(tmp, file);
}

/** Record one failed boot attempt. Prunes out-of-window failures first. */
export async function noteBootFailure(reason: string): Promise<void> {
  const now = Date.now();
  const state = await readState(BOOT_ATTEMPTS_FILE);
  const failures = prune(state.failures, now, DEFAULT_BOOT_WINDOW_MS);
  failures.push({ at: new Date(now).toISOString(), reason });
  await writeState({ ...state, failures }, BOOT_ATTEMPTS_FILE);
}

/**
 * Record a successful boot. Resets the failure streak — once we are actually
 * serving, earlier failures (often a transient prerequisite) are history and
 * must not count toward tripping a later, unrelated boot.
 */
export async function noteBootSuccess(): Promise<void> {
  await writeState({ failures: [], lastSuccessAt: new Date().toISOString() }, BOOT_ATTEMPTS_FILE);
}

/** Number of failures inside the trailing `windowMs`. */
export async function bootFailureCount(windowMs: number = DEFAULT_BOOT_WINDOW_MS): Promise<number> {
  const state = await readState(BOOT_ATTEMPTS_FILE);
  return prune(state.failures, Date.now(), windowMs).length;
}

/** True when too many boots failed recently (auto-restart is thrashing). */
export async function autoRestartExhausted(
  opts: { threshold?: number; windowMs?: number } = {},
): Promise<boolean> {
  const state = await readState(BOOT_ATTEMPTS_FILE);
  return shouldTrip(state.failures, Date.now(), opts);
}

/** Clear the failure streak (keep lastSuccessAt). Used by manual recovery. */
export async function clearBootFailures(): Promise<void> {
  const state = await readState(BOOT_ATTEMPTS_FILE);
  await writeState({ failures: [], lastSuccessAt: state.lastSuccessAt }, BOOT_ATTEMPTS_FILE);
}
