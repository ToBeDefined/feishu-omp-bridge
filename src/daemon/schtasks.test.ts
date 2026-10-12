import { describe, expect, it, vi } from 'vitest';

const spawnSyncMock = vi.hoisted(() => vi.fn());
vi.mock('node:child_process', () => ({ spawnSync: spawnSyncMock }));

import { endAndDisable, installTask, isRunningStatusOutput, parseTaskStatus } from './schtasks';

describe('installTask', () => {
  it('passes the /TR launcher path as a bare argv element without manual quoting', async () => {
    spawnSyncMock.mockReturnValue({ status: 0, stdout: '', stderr: '' });
    await installTask();
    const args = spawnSyncMock.mock.calls[0]?.[1] as string[];
    const trIndex = args.indexOf('/TR');
    expect(trIndex).toBeGreaterThan(0);
    expect(args[trIndex + 1]).not.toMatch(/"/);
  });
});

describe('endAndDisable', () => {
  it('surfaces the disable result when /End fails on a not-running task', () => {
    spawnSyncMock.mockImplementation((_cmd, args) =>
      args[0] === '/End' ? { status: 1, stdout: '', stderr: 'not running' } : { status: 0, stdout: '', stderr: '' },
    );
    expect(endAndDisable()).toMatchObject({ ok: true });
  });

  it('reports failure when both /End and /Change fail', () => {
    spawnSyncMock.mockReturnValue({ status: 1, stdout: '', stderr: 'boom' });
    expect(endAndDisable()).toMatchObject({ ok: false });
  });
});

describe('isRunningStatusOutput', () => {
  it('matches English running state', () => {
    expect(isRunningStatusOutput('Status: Running')).toBe(true);
  });

  it('matches Chinese running state', () => {
    expect(isRunningStatusOutput('状态: 正在运行')).toBe(true);
  });

  it('does not match ready / disabled states', () => {
    expect(isRunningStatusOutput('Status: Ready')).toBe(false);
    expect(isRunningStatusOutput('状态: 就绪')).toBe(false);
    expect(isRunningStatusOutput('Status: Disabled')).toBe(false);
  });

  it('does not match unknown / unrecognized localized state output', () => {
    expect(isRunningStatusOutput('Status: Could not start')).toBe(false);
    expect(isRunningStatusOutput('État: En cours d’exécution')).toBe(false);
    expect(isRunningStatusOutput('')).toBe(false);
  });
});

const queryOutput = (lastResult: string, pid?: string) =>
  [
    'TaskName: \\FeishuOmpBridge',
    pid ? `Process ID: ${pid}` : 'Process ID: 0',
    `Last Result: ${lastResult}`,
  ].join('\n');

describe('parseTaskStatus', () => {
  it('extracts pid and a real exit code', () => {
    expect(parseTaskStatus(queryOutput('1', '4242'))).toEqual({ pid: '4242', lastExit: '1' });
  });

  it('filters the 1056 / 267011 sentinel codes to undefined', () => {
    expect(parseTaskStatus(queryOutput('1056')).lastExit).toBeUndefined();
    expect(parseTaskStatus(queryOutput('267011')).lastExit).toBeUndefined();
  });

  it('returns undefined pid when the task is not running', () => {
    expect(parseTaskStatus(queryOutput('0')).pid).toBeUndefined();
  });
});
