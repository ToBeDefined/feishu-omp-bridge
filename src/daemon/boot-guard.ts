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
  /** 写这条记录的进程 pid：用来锚定「本轮 boot 的那条记录」。 */
  pid?: number;
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
            ((f as BootFailure).pid === undefined || typeof (f as BootFailure).pid === 'number') &&
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
/** 本进程是否已经为本轮 boot 记过一次（每进程至多一条记录）。 */
let recordedThisBoot = false;

/** 重置「本进程已记账」标记。仅供测试与模拟多轮 boot 使用。 */
export function resetBootGuardProcessState(): void {
  recordedThisBoot = false;
}

/**
 * 记一次「boot 尝试」。**每轮 boot 只要没走到 noteBootSuccess 就是失败**，
 * 因此这条记录由进程自己在启动时写下：崩溃、超时、未捕获异常等没有显式
 * exit(1) 的失败也会被统计（只埋显式退出点会漏掉最常见的崩溃型失败）。
 * 走到 noteBootSuccess 时整份状态被清空，所以正常运行不会留下记录。
 */
export async function noteBootStarted(): Promise<void> {
  const now = Date.now();
  const state = await readState(BOOT_ATTEMPTS_FILE);
  const failures = prune(state.failures, now, DEFAULT_BOOT_WINDOW_MS);
  const last = failures[failures.length - 1];
  // 以 pid 锚定：本进程已有本轮记录就不重复写。用 pid 而不是纯内存标记，
  // 是因为 `clearBootFailures()`（人工恢复路径）会把文件清空，此时内存标记
  // 仍为真 —— 若只看标记，恢复中的这轮 boot 就不会被登记（它再崩就漏计）。
  if (last && last.pid === process.pid) {
    recordedThisBoot = true;
    return;
  }
  recordedThisBoot = true;
  failures.push({ at: new Date(now).toISOString(), reason: 'start', pid: process.pid });
  await writeState({ ...state, failures }, BOOT_ATTEMPTS_FILE);
}

/**
 * 给本轮的记录补一个具体原因（`start` → `duplicate-instance` 等）。同进程
 * 首次调用会就地升级原因，不额外增加计数；若本轮没走过 noteBootStarted
 * （例如测试直接调用）则补记一条。
 */
export async function noteBootFailure(reason: string): Promise<void> {
  const now = Date.now();
  const state = await readState(BOOT_ATTEMPTS_FILE);
  const failures = prune(state.failures, now, DEFAULT_BOOT_WINDOW_MS);
  const last = failures[failures.length - 1];
  // 以 pid 锚定本轮记录：同进程重复调用只升级原因，不重复计数；若本轮记录
  // 不在（本轮没走过 noteBootStarted，或状态被外部清过），就补记一条。
  if (last && last.pid === process.pid && last.reason === 'start') {
    failures[failures.length - 1] = { ...last, reason };
    await writeState({ ...state, failures }, BOOT_ATTEMPTS_FILE);
    recordedThisBoot = true;
    return;
  }
  if (recordedThisBoot) return; // 本轮已有记录且原因已具体：不再重复计数
  recordedThisBoot = true;
  failures.push({ at: new Date(now).toISOString(), reason, pid: process.pid });
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
