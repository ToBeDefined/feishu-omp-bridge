import { spawn, writeFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { BridgeChannel } from '../../bot/channel';

type ConfigStoreModule = typeof import('../../config/store');

// runStart 的启动窗口测试：startChannel 永不 resolve（模拟建连卡住），
// loadConfig 挂在闸门上，手动放行以精确控制 runStart 走到哪一步。
const h = vi.hoisted(() => ({
  releaseConfig: undefined as ((value: unknown) => void) | undefined,
}));
vi.mock('../../bot/channel', () => ({
  startChannel: vi.fn((): Promise<BridgeChannel> => new Promise(() => {})),
}));
vi.mock('../../agent', () => ({
  OmpAdapter: class {
    isAvailable = async () => true;
    displayName = 'omp';
    id = 'omp';
  },
}));
vi.mock('../preflight', () => ({ preFlightChecks: vi.fn(async () => {}) }));
vi.mock('../../config/store', async (importOriginal) => {
  const actual = (await importOriginal()) as ConfigStoreModule;
  return {
    ...actual,
    // Executor 形式：闸门 resolve 需要在 runStart 之外手动触发
    //（Promise.withResolvers 需要 Node 22+，本包支持 Node >= 20）。
    loadConfig: vi.fn(
      () =>
        new Promise((resolve) => {
          h.releaseConfig = resolve as (value: unknown) => void;
        }),
    ),
  };
});
vi.mock('../../core/logger', () => ({
  log: { info: vi.fn(), warn: vi.fn(), fail: vi.fn() },
  gcOldLogs: vi.fn(async () => {}),
}));
vi.mock('../../media/cache', () => ({
  gcMediaCache: vi.fn(async () => {}),
  MEDIA_GC_MAX_AGE_MS: 86_400_000,
}));

import { paths } from '../../config/paths';
import { readAndPrune, type ProcessEntry } from '../../runtime/registry';
import { startChannel } from '../../bot/channel';
import { isReplaceableConflict, replaceSupersededConflicts, runStart } from './start';

const SENTINEL_ID = 'zz99';

function sentinelEntry(): ProcessEntry {
  return {
    id: SENTINEL_ID,
    pid: process.pid, // 必然存活，readAndPrune 不会剪掉
    appId: 'cli_other',
    tenant: 'feishu',
    configPath: '/tmp/other.json',
    startedAt: new Date().toISOString(),
    version: '0.1.0',
  };
}

function writeRegistry(entries: ProcessEntry[]): void {
  writeFileSync(paths.processesFile, JSON.stringify({ entries }), 'utf8');
}

function registryIds(): string[] {
  return readAndPrune().map((e) => e.id);
}

/** process.exit 桩：记录退出码但不真退 —— stop() 的信号处理器是
 * fire-and-forget，桩必须正常返回，否则会产生 unhandledRejection。 */
function captureExit(): number[] {
  const codes: number[] = [];
  vi.spyOn(process, 'exit').mockImplementation(((code?: string | number | null) => {
    codes.push(Number(code ?? 0));
  }) as unknown as () => never);
  return codes;
}

let pending: Promise<void> | undefined;

beforeEach(() => {
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(() => {
  // runStart 永远停在 startChannel 的 pending promise 上；接住它的拒绝
  // （若有），避免污染 worker 的 unhandledRejection 统计。
  pending?.catch(() => {});
  pending = undefined;
  vi.restoreAllMocks();
});

describe('runStart 信号处理时序', () => {
  it('启动窗口内（config 未加载完）收到 SIGINT：优雅退出，且不注销别人的注册项', async () => {
    writeRegistry([sentinelEntry()]);
    const codes = captureExit();

    pending = runStart({});
    // 信号处理器在第一个 await 之前注册 —— runStart() 一返回就有效。
    process.emit('SIGINT');

    await vi.waitFor(() => expect(codes).toEqual([0]));
    // entry 尚未注册 → stop() 的守卫跳过注销；哨兵注册项毫发无损。
    expect(registryIds()).toEqual([SENTINEL_ID]);
  });

  it('注册完成后、建连卡住时收到 SIGTERM：注销自己 + 优雅退出，不动哨兵', async () => {
    writeRegistry([sentinelEntry()]);
    const codes = captureExit();

    pending = runStart({});
    // 放行 config 读取，让 runStart 走完注册、停在建连上。
    h.releaseConfig?.({
      accounts: { app: { id: 'cli_self', tenant: 'feishu', secret: '${FOB_TEST_SECRET}' } },
      preferences: {},
    });
    await vi.waitFor(() => expect(registryIds()).toHaveLength(2));

    process.emit('SIGTERM');

    await vi.waitFor(() => expect(codes).toEqual([0]));
    const ids = registryIds();
    expect(ids).toContain(SENTINEL_ID); // 别人的注册项不受影响
    expect(ids.filter((id) => id !== SENTINEL_ID)).toEqual([]); // 自己的已注销
    // 建连从未完成 → 没有任何 bridge 可断开；startChannel 恰好被调一次。
    expect(vi.mocked(startChannel)).toHaveBeenCalledTimes(1);
  });
});

describe('replaceSupersededConflicts（孤儿/前任顶替）', () => {
  const base = (pid: number): ProcessEntry => ({
    id: 'conf1',
    pid,
    appId: 'cli_x',
    tenant: 'feishu',
    configPath: '/tmp/x.json',
    startedAt: new Date().toISOString(),
    version: '0.1.0',
  });

  it('supervised 环境下无条件顶替：SIGTERM 后冲突实例退出', async () => {
    const child = spawn('sleep', ['30'], { stdio: 'ignore' });
    try {
      const remaining = await replaceSupersededConflicts([base(child.pid!)], {
        supervised: true,
        timeoutMs: 2000,
      });
      expect(remaining).toEqual([]); // 已退出
    } finally {
      try { child.kill('SIGKILL'); } catch { /* 已退出 */ }
    }
  });

  it('非 supervised 下只顶替孤儿（ppid=1）或已消失条目，活终端实例保留', async () => {
    const child = spawn('sleep', ['30'], { stdio: 'ignore' });
    try {
      const dead = base(999999); // 已消失 → readAndPrune 竞态，可顶替
      const foreground = base(child.pid!); // 父进程是本测试进程（活着）→ 不动
      const remaining = await replaceSupersededConflicts(
        [dead, foreground],
        { supervised: false, timeoutMs: 500 },
      );
      expect(remaining.map((e) => e.pid)).toEqual([child.pid]);
    } finally {
      try { child.kill('SIGKILL'); } catch { /* 已退出 */ }
    }
  });

  it('isReplaceableConflict：supervised=true 恒真；否则看 ppid', () => {
    const ppidOf = (pid: number): number | undefined => (pid === 100 ? 1 : pid === 200 ? 4242 : undefined);
    expect(isReplaceableConflict(base(1), ppidOf, true)).toBe(true);
    expect(isReplaceableConflict(base(100), ppidOf, false)).toBe(true); // ppid=1 孤儿
    expect(isReplaceableConflict(base(200), ppidOf, false)).toBe(false); // 活终端
    expect(isReplaceableConflict(base(300), ppidOf, false)).toBe(true); // 已消失
  });
});
