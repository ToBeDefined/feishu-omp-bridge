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
import { runStart } from './start';

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
