import { spawn, type ChildProcess } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// getServiceAdapter 是 ps.ts 探测「托管进程」的唯一入口 —— 换成可控桩，
// 绝不让测试碰真实 launchctl/systemctl。
const h = vi.hoisted(() => ({ adapter: undefined as unknown }));
vi.mock('../../daemon/service-adapter', () => ({
  getServiceAdapter: () => h.adapter,
}));

import type { ServiceAdapter } from '../../daemon/service-adapter';
import { paths } from '../../config/paths';
import { isAlive, readAndPrune, type ProcessEntry } from '../../runtime/registry';
import { findManagedPid, inManagedTree, runKillCli } from './ps';

function writeRegistry(entries: ProcessEntry[]): void {
  writeFileSync(paths.processesFile, JSON.stringify({ entries }), 'utf8');
}

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

function stubAdapter(over: Partial<ServiceAdapter> = {}): ServiceAdapter {
  return {
    platformName: 'test (mock)',
    fileExists: () => true,
    isRunning: () => false,
    servicePath: () => '/tmp/test-service',
    install: async () => {},
    start: () => ({ ok: true, stderr: '' }),
    stop: () => ({ ok: true, stderr: '' }),
    stopAndDisableAutostart: () => ({ ok: true, stderr: '' }),
    restart: () => ({ ok: true, stderr: '' }),
    waitUntilStopped: async () => true,
    deleteFile: async () => {},
    describeStatus: () => '',
    parseStatus: () => ({}),
    ...over,
  };
}

/** 可被 SIGTERM 干净杀掉的哑进程；挂 exit 监听保证及时收尸（僵尸 pid 会让
 * isAlive 一直为 true）。 */
function spawnDummyChild(): ChildProcess {
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1e9)'], {
    stdio: 'ignore',
  });
  child.once('exit', () => {});
  return child;
}

const children: ChildProcess[] = [];
let logs: string[];

type ExitCode = string | number | null | undefined;

function captureExit(): number[] {
  const codes: number[] = [];
  vi.spyOn(process, 'exit').mockImplementation(((code?: ExitCode) => {
    codes.push(Number(code ?? 0));
    throw new Error(`__process_exit_${code ?? 0}__`);
  }) as unknown as () => never);
  return codes;
}

beforeEach(() => {
  logs = [];
  vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
    logs.push(args.map(String).join(' '));
  });
  vi.spyOn(console, 'warn').mockImplementation((...args: unknown[]) => {
    logs.push(args.map(String).join(' '));
  });
  vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
    logs.push(args.map(String).join(' '));
  });
});

afterEach(() => {
  for (const c of children.splice(0)) c.kill('SIGKILL');
  h.adapter = undefined;
  vi.restoreAllMocks();
});

describe('findManagedPid', () => {
  it('服务未安装（fileExists=false）时返回 undefined，且不查状态', () => {
    const describeStatus = vi.fn(() => '');
    const adapter = stubAdapter({ fileExists: () => false, describeStatus });
    expect(findManagedPid(adapter)).toBeUndefined();
    expect(describeStatus).not.toHaveBeenCalled();
  });

  it('服务存在但未在运行时返回 undefined', () => {
    const adapter = stubAdapter({ fileExists: () => true, isRunning: () => false });
    expect(findManagedPid(adapter)).toBeUndefined();
  });

  it('在运行时从 parseStatus 提取正数 pid', () => {
    const adapter = stubAdapter({
      isRunning: () => true,
      describeStatus: () => 'pid = 4242',
      parseStatus: (text: string) => ({ pid: /pid = (\d+)/.exec(text)?.[1] }),
    });
    expect(findManagedPid(adapter)).toBe(4242);
  });

  it('parseStatus 没有 pid（loaded 但未 running）返回 undefined', () => {
    const adapter = stubAdapter({
      isRunning: () => true,
      describeStatus: () => 'state = not running',
      parseStatus: () => ({}),
    });
    expect(findManagedPid(adapter)).toBeUndefined();
  });

  it('describeStatus 抛错时吞掉并返回 undefined', () => {
    const adapter = stubAdapter({
      isRunning: () => true,
      describeStatus: () => {
        throw new Error('launchctl exploded');
      },
    });
    expect(findManagedPid(adapter)).toBeUndefined();
  });
});

describe('inManagedTree', () => {
  const parentOf = (map: Record<number, number | undefined>) => (pid: number) => map[pid];

  it('目标就是托管 pid 时直接命中，不查父进程', () => {
    const parentOfSpy = vi.fn(() => undefined);
    expect(inManagedTree(100, 100, parentOfSpy)).toBe(true);
    expect(parentOfSpy).not.toHaveBeenCalled();
  });

  it('目标是托管 pid 的后代（macOS supervisor 形态）时命中', () => {
    // launchd(100) → supervisor(200) → node(300)：目标 300 归托管树
    const p = parentOf({ 300: 200, 200: 100, 100: 1 });
    expect(inManagedTree(300, 100, p)).toBe(true);
    expect(inManagedTree(200, 100, p)).toBe(true);
  });

  it('无亲缘关系返回 false', () => {
    const p = parentOf({ 300: 200, 200: 1 });
    expect(inManagedTree(300, 999, p)).toBe(false);
  });

  it('到 init(1) 为止找不到就停', () => {
    const p = parentOf({ 300: 1 });
    expect(inManagedTree(300, 100, p)).toBe(false);
  });

  it('ppid 成环时有界深度兜底，不死循环', () => {
    const p = parentOf({ 5: 5 });
    expect(inManagedTree(5, 100, p)).toBe(false);
  });
});

describe('runKillCli — 托管进程走服务管理器', () => {
  it('目标 pid 就是托管 pid：走 adapter.stop + waitUntilStopped，不裸 kill', async () => {
    const child = spawnDummyChild();
    children.push(child);
    writeRegistry([entry({ id: 'ab12', pid: child.pid! })]);
    const stop = vi.fn(() => ({ ok: true, stderr: '' }));
    const waitUntilStopped = vi.fn(async () => true);
    h.adapter = stubAdapter({
      isRunning: () => true,
      describeStatus: () => `pid = ${child.pid}`,
      parseStatus: (text: string) => ({ pid: /pid = (\d+)/.exec(text)?.[1] }),
      stop,
      waitUntilStopped,
    });

    await runKillCli('ab12');

    expect(stop).toHaveBeenCalledTimes(1);
    expect(waitUntilStopped).toHaveBeenCalled();
    expect(logs.join('\n')).toContain('已关闭 bot ab12');
    // 托管路径绝不直接碰进程 —— child 必须还活着。
    expect(child.kill(0)).toBe(true);
  });

  it('目标 pid 是托管 pid 的后代（supervisor 场景）同样走 adapter', async () => {
    const child = spawnDummyChild();
    children.push(child);
    writeRegistry([entry({ id: 'ab12', pid: child.pid! })]);
    const stop = vi.fn(() => ({ ok: true, stderr: '' }));
    h.adapter = stubAdapter({
      isRunning: () => true,
      describeStatus: () => `pid = ${process.pid}`, // 托管 pid = 当前测试进程（child 的父进程）
      parseStatus: (text: string) => ({ pid: /pid = (\d+)/.exec(text)?.[1] }),
      stop,
    });

    await runKillCli('ab12');

    // child 的 ppid 链上第一个就是测试进程 → 命中托管树
    expect(stop).toHaveBeenCalledTimes(1);
    expect(logs.join('\n')).toContain('已关闭 bot ab12');
  });

  it('stop 失败：如实报错并 exit(1)，不谎报已关闭', async () => {
    const child = spawnDummyChild();
    children.push(child);
    writeRegistry([entry({ id: 'ab12', pid: child.pid! })]);
    const codes = captureExit();
    h.adapter = stubAdapter({
      isRunning: () => true,
      describeStatus: () => `pid = ${child.pid}`,
      parseStatus: (text: string) => ({ pid: /pid = (\d+)/.exec(text)?.[1] }),
      stop: () => ({ ok: false, stderr: 'bootout failed\n' }),
    });

    await expect(runKillCli('ab12')).rejects.toThrow('__process_exit_1__');

    expect(codes).toEqual([1]);
    expect(logs.join('\n')).toContain('关闭失败');
    expect(logs.join('\n')).not.toContain('已关闭');
  });

  it('stop 成功但超时未停：exit(1) 而不是假成功', async () => {
    const child = spawnDummyChild();
    children.push(child);
    writeRegistry([entry({ id: 'ab12', pid: child.pid! })]);
    const codes = captureExit();
    h.adapter = stubAdapter({
      isRunning: () => true,
      describeStatus: () => `pid = ${child.pid}`,
      parseStatus: (text: string) => ({ pid: /pid = (\d+)/.exec(text)?.[1] }),
      waitUntilStopped: async () => false,
    });

    await expect(runKillCli('ab12')).rejects.toThrow('__process_exit_1__');

    expect(codes).toEqual([1]);
    expect(logs.join('\n')).not.toContain('已关闭');
  });
});

describe('runKillCli — 非托管走原逻辑', () => {
  it('服务不在运行（或没装）时维持裸 SIGTERM + 轮询', async () => {
    const child = spawnDummyChild();
    children.push(child);
    writeRegistry([entry({ id: 'ab12', pid: child.pid! })]);
    const stop = vi.fn(() => ({ ok: true, stderr: '' }));
    h.adapter = stubAdapter({ isRunning: () => false, stop });

    // runKillCli 打印「已关闭」前才会返回 —— 直接等 promise，不猜时长。
    await runKillCli('ab12');

    // 原路径生效：没走 adapter，目标进程真的死了。
    expect(stop).not.toHaveBeenCalled();
    expect(isAlive(child.pid!)).toBe(false);
  });

  it('没有可用 adapter（不支持的平台）同样裸 kill', async () => {
    const child = spawnDummyChild();
    children.push(child);
    writeRegistry([entry({ id: 'ab12', pid: child.pid! })]);
    h.adapter = null;

    await runKillCli('ab12');
    expect(isAlive(child.pid!)).toBe(false);
  });

  it('注册表查无此目标：报错退出，不碰任何进程', async () => {
    writeRegistry([]);
    const kill = vi.spyOn(process, 'kill');
    const codes = captureExit();

    await expect(runKillCli('nope')).rejects.toThrow('__process_exit_1__');

    expect(codes).toEqual([1]);
    expect(logs.join('\n')).toContain('没找到匹配的 bot');
    expect(kill).not.toHaveBeenCalled();
  });
});
