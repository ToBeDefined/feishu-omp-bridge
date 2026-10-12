import { spawn, type ChildProcess } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

type ChildProcessModule = typeof import('node:child_process');
type ConfigStoreModule = typeof import('../../config/store');

// pgrep 输出桩：killStrayProcesses 是唯一消费者。
const h = vi.hoisted(() => ({ pgrepOutput: '' }));
vi.mock('node:child_process', async (importOriginal) => {
  // spread 真模块：spawn 必须是真的（测试要拉活进程），只换 execFile。
  const actual = (await importOriginal()) as ChildProcessModule;
  return {
    ...actual,
    execFile: ((cmd: string, args: string[], cb: (err: null, out: { stdout: string }) => void) => {
      expect(cmd).toBe('pgrep');
      cb(null, { stdout: h.pgrepOutput });
      return undefined as never;
    }) as unknown as ChildProcessModule['execFile'],
  };
});

vi.mock('../../config/store', async (importOriginal) => {
  const actual = (await importOriginal()) as ConfigStoreModule;
  return {
    ...actual,
    loadConfig: vi.fn(async () => ({
      accounts: { app: { id: 'cli_app', tenant: 'feishu' } },
    })),
  };
});

import { paths } from '../../config/paths';
import type { ProcessEntry } from '../../runtime/registry';
import { isAlive } from '../../runtime/registry';
import { killStrayProcesses, selectStrayPids } from './service';

function entry(over: Partial<ProcessEntry> = {}): ProcessEntry {
  return {
    id: 'ab12',
    pid: 0,
    appId: 'cli_app',
    tenant: 'feishu',
    configPath: '/tmp/config.json',
    startedAt: '2026-10-11T00:00:00.000Z',
    version: '0.1.0',
    ...over,
  };
}

function writeRegistry(entries: ProcessEntry[]): void {
  writeFileSync(paths.processesFile, JSON.stringify({ entries }), 'utf8');
}

/** 可 SIGTERM 的哑进程；挂 exit 监听确保及时收尸（僵尸 pid 会骗过 isAlive）。 */
function spawnDummyChild(): ChildProcess {
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1e9)'], {
    stdio: 'ignore',
  });
  child.once('exit', () => {});
  return child;
}

const children: ChildProcess[] = [];

beforeEach(() => {
  vi.spyOn(console, 'log').mockImplementation(() => {});
});

afterEach(() => {
  for (const c of children.splice(0)) c.kill('SIGKILL');
  vi.restoreAllMocks();
});

describe('selectStrayPids', () => {
  it('跳过空行 / 垃圾行 / 非正数', () => {
    expect(selectStrayPids('\n  \nabc\n0\n-3\n  42  \n', new Set(), 1)).toEqual([42]);
  });

  it('永远排除 CLI 进程自身', () => {
    expect(selectStrayPids('123\n', new Set(), 123)).toEqual([]);
  });

  it('注册表里任何 entry 的 pid 都受保护（不分 app）', () => {
    const protectedPids = new Set([10, 20]);
    expect(selectStrayPids('10\n20\n30\n40\n', protectedPids, 1)).toEqual([30, 40]);
  });

  it('空输出返回空数组', () => {
    expect(selectStrayPids('', new Set(), 1)).toEqual([]);
  });
});

describe('killStrayProcesses', () => {
  it('清理同 app 注册残留，但注册表里其他 app 的 pid 绝不被 pgrep 误杀', async () => {
    const sameApp = spawnDummyChild();
    const otherApp = spawnDummyChild();
    children.push(sameApp, otherApp);
    const strayPid = 99999999; // 必然不存在的野进程

    writeRegistry([
      entry({ id: 'aa11', pid: sameApp.pid!, appId: 'cli_app' }),
      entry({ id: 'bb22', pid: otherApp.pid!, appId: 'cli_other' }),
    ]);
    h.pgrepOutput = `${sameApp.pid}\n${otherApp.pid}\n${strayPid}\n\n`;

    // 拦截 process.kill 记账（放行真实信号，isAlive 的 0 号探测依赖它；
    // 只记 SIGTERM，避免把存活性探测误记成「杀人」）。
    const realKill = process.kill.bind(process);
    const killed: Array<{ pid: number; signal: string | number | undefined }> = [];
    vi.spyOn(process, 'kill').mockImplementation(((pid: number, signal?: string) => {
      if (signal === 'SIGTERM') killed.push({ pid, signal });
      return realKill(pid, signal as never);
    }) as unknown as typeof process.kill);

    const realArgv1 = process.argv[1] ?? '';
    process.argv[1] = '/usr/local/bin/feishu-omp-bridge.mjs';
    try {
      await killStrayProcesses();
    } finally {
      process.argv[1] = realArgv1;
    }

    // 同 app 注册残留：注册表阶段清理，恰好一次。
    expect(killed.filter((k) => k.pid === sameApp.pid && k.signal === 'SIGTERM')).toHaveLength(1);
    // 真野进程（注册表查无此 pid）：pgrep 阶段清理。
    expect(killed.filter((k) => k.pid === strayPid && k.signal === 'SIGTERM')).toHaveLength(1);
    // 回归核心：其他 app 的合法注册实例绝不被碰，且活到最后。
    expect(killed.filter((k) => k.pid === otherApp.pid)).toEqual([]);
    expect(() => realKill(otherApp.pid!, 0)).not.toThrow();
    // CLI 自身不在清理名单里。
    expect(killed.filter((k) => k.pid === process.pid)).toEqual([]);
  });

  it('注册表里的 pid 全部受保护：pgrep 只补刀注册表外的进程', async () => {
    // 其他 app 的注册实例：pgrep 能匹配到它，但注册表保护它不被误杀
    // （同 app 的注册残留由清理阶段负责，不归 pgrep 管）。
    const registered = spawnDummyChild();
    children.push(registered);
    writeRegistry([entry({ id: 'bb22', pid: registered.pid!, appId: 'cli_other' })]);
    h.pgrepOutput = `${registered.pid}\n`; // pgrep 只命中注册实例

    const realKill = process.kill.bind(process);
    const killed: number[] = [];
    vi.spyOn(process, 'kill').mockImplementation(((pid: number, signal?: string) => {
      if (signal === 'SIGTERM') killed.push(pid);
      return realKill(pid, signal as never);
    }) as unknown as typeof process.kill);

    const realArgv1 = process.argv[1] ?? '';
    process.argv[1] = '/usr/local/bin/feishu-omp-bridge.mjs';
    try {
      await killStrayProcesses();
    } finally {
      process.argv[1] = realArgv1;
    }

    expect(killed).toEqual([]); // 没有任何未注册进程 → 无人被杀
    expect(isAlive(registered.pid!)).toBe(true);
  });
});
