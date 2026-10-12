import { describe, expect, it } from 'vitest';
import { orphanTestWorkerPids } from './strays';

const ps = (rows: Array<[number, number, string]>): string =>
  rows.map(([pid, ppid, cmd]) => `${String(pid).padStart(6)} ${String(ppid).padStart(6)} ${cmd}`).join('\n');

describe('orphanTestWorkerPids', () => {
  it('只挑 ppid=1 的 vitest worker', () => {
    const out = ps([
      [100, 1, 'node (vitest 3)'],
      [200, 950, 'node (vitest 7)'], // 父进程活着：开发者自己的测试，不碰
      [300, 1, '/Users/x/node /repo/node_modules/.bin/vitest run'], // 主进程不是 worker 形态
      [400, 1, 'node (vitest 11)'],
      [500, 1, '/bin/bash'],
    ]);
    expect(orphanTestWorkerPids(out, 999)).toEqual([100, 400]);
  });

  it('不会把自己算进去', () => {
    const out = ps([[100, 1, 'node (vitest 3)']]);
    expect(orphanTestWorkerPids(out, 100)).toEqual([]);
  });

  it('空输入与畸形行都安全', () => {
    expect(orphanTestWorkerPids('')).toEqual([]);
    expect(orphanTestWorkerPids('garbage\n\n   \n1 2')).toEqual([]);
  });
});
