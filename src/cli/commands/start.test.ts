import { spawn } from 'node:child_process';
import { rmSync, writeFileSync, readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { BridgeChannel } from '../../bot/channel';

type ConfigStoreModule = typeof import('../../config/store');

// runStart 的启动窗口测试：startChannel 永不 resolve（模拟建连卡住），
// loadConfig 挂在闸门上，手动放行以精确控制 runStart 走到哪一步。
const h = vi.hoisted(() => ({
  releaseConfig: undefined as ((value: unknown) => void) | undefined,
  /** When true, loadConfig resolves immediately with `configValue` (used by
   *  tests that must run past boot without hanging on the gate). */
  autoResolve: false,
  configValue: undefined as unknown,
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
vi.mock('../../daemon/launchd', () => ({
  bootout: vi.fn(() => ({ ok: true, stdout: '', stderr: '' })),
  kickstart: vi.fn(() => ({ ok: true, stdout: '', stderr: '' })),
  rotateDaemonLogsIfNeeded: vi.fn(async () => {}),
}));
vi.mock('../preflight', () => ({ preFlightChecks: vi.fn(async () => {}) }));
vi.mock('../../config/store', async (importOriginal) => {
  const actual = (await importOriginal()) as ConfigStoreModule;
  return {
    ...actual,
    // Executor 形式：闸门 resolve 需要在 runStart 之外手动触发
    //（Promise.withResolvers 需要 Node 22+，本包支持 Node >= 20）。
    loadConfig: vi.fn(() => {
      if (h.autoResolve) return Promise.resolve(h.configValue);
      return new Promise((resolve) => {
        h.releaseConfig = resolve as (value: unknown) => void;
      });
    }),
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
import { bootout } from '../../daemon/launchd';
import {
  BOOT_ATTEMPTS_FILE,
  bootFailureCount,
  noteBootFailure,
  resetBootGuardProcessState,
} from '../../daemon/boot-guard';
import { preFlightChecks } from '../preflight';
import {
  isOrphaned,
  isReplaceableConflict,
  replaceSupersededConflicts,
  runStart,
} from './start';

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
  resetBootGuardProcessState();
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  h.autoResolve = false;
  h.configValue = undefined;
  h.releaseConfig = undefined;
  delete process.env.FOB_SUPERVISED;
  vi.mocked(preFlightChecks).mockClear();
  vi.mocked(bootout).mockClear();
  // 熔断状态文件在 worker 级临时目录里被所有用例共享，先清干净。
  rmSync(BOOT_ATTEMPTS_FILE, { force: true });
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
    // runStart 现在先 await 熔断闸门，故 loadConfig 的闸门句柄稍后才就位。
    await vi.waitFor(() => expect(h.releaseConfig).toBeTypeOf('function'));
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

describe('isOrphaned', () => {
  it('仅 FOB_SUPERVISED 且 ppid=1 才算孤儿', () => {
    expect(isOrphaned(1, true)).toBe(true);
    expect(isOrphaned(1, false)).toBe(false); // 非 supervised：ppid=1 是正常的终端退出
    expect(isOrphaned(4242, true)).toBe(false); // supervisor 还活着
  });
});

describe('runStart 失败路径最短化 + 熔断', () => {
  it('第二次信号直接 exit(1)，不再被 stopping 静默吞掉', async () => {
    const codes = captureExit();
    pending = runStart({});
    // 首轮 stop() 同步进入 stopping=true 后就 await，第二次信号应强杀。
    process.emit('SIGINT');
    process.emit('SIGINT');
    await vi.waitFor(() => expect(codes).toContain(1));
  });

  it('非 TTY 且配置不完整：exit(1) + 记录失败，且不做 preflight', async () => {
    const codes = captureExit();
    pending = runStart({});
    await vi.waitFor(() => expect(h.releaseConfig).toBeTypeOf('function'));
    h.releaseConfig?.({ accounts: { app: { id: 'cli_x' } } }); // 缺 tenant/secret
    await vi.waitFor(() => expect(codes).toEqual([1]));
    expect(vi.mocked(preFlightChecks)).not.toHaveBeenCalled();
    expect(await bootFailureCount()).toBe(1);
  });

  it('熔断已触发且非 supervised：清零失败计数后继续启动', async () => {
    // 每轮 boot 只记一条（同进程用 reset 模拟 5 轮）→ 触发熔断
    for (let i = 0; i < 5; i++) {
      resetBootGuardProcessState();
      await noteBootFailure('boom');
    }
    expect(await bootFailureCount()).toBe(5);

    pending = runStart({});
    // 熔断被放行 → 走到 loadConfig 挂闸门（说明继续了、没退）。
    await vi.waitFor(() => expect(h.releaseConfig).toBeTypeOf('function'));
    // 旧的 5 条被清零；本轮 boot 重新登记了一条 in-flight 记录（成功启动时会清掉）。
    const state = JSON.parse(readFileSync(BOOT_ATTEMPTS_FILE, 'utf8')) as {
      failures: Array<{ reason: string }>;
    };
    expect(state.failures.map((f) => f.reason)).toEqual(['start']);
  });

  it('熔断已触发且 supervised：bootout + exit(0)，不做任何重活', async () => {
    process.env.FOB_SUPERVISED = '1';
    h.autoResolve = true;
    h.configValue = {
      accounts: { app: { id: 'cli_x', tenant: 'feishu', secret: '${FOB_TEST_SECRET}' } },
      preferences: {},
    };
    for (let i = 0; i < 5; i++) {
      resetBootGuardProcessState();
      await noteBootFailure('boom');
    }
    const codes = captureExit();
    await runStart({});
    expect(codes).toEqual([0]);
    expect(vi.mocked(bootout)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(preFlightChecks)).not.toHaveBeenCalled();
  });
});
