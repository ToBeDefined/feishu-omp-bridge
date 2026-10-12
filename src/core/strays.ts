import { execFileSync } from 'node:child_process';
import { log } from './logger';

/**
 * 孤儿测试 worker 清扫。
 *
 * 场景：`/release` 的测试步骤跑完后，随后的 `kickstart -k` 会 SIGTERM 掉整个
 * 守护进程树 —— vitest 的 worker 池若还没完成 teardown，就会以孤儿（ppid=1）
 * 身份残留下来：每个占数 GB RSS、持续占住 CPU，且没有任何父进程会再来回收它们。
 * 实测一次发布留下 10 个这样的大块头。
 *
 * 判据保守到不可能误伤：**ppid 必须是 1**（父进程已消失 = 真的没人管了）并且
 * 命令行形如 vitest worker。开发者自己在终端跑的 vitest worker 的父进程活着，
 * 不会命中。
 */

/** 从 `ps -A -o pid=,ppid=,command=` 的输出里挑出孤儿 vitest worker 的 pid。 */
export function orphanTestWorkerPids(psOutput: string, selfPid: number = process.pid): number[] {
  const pids: number[] = [];
  for (const line of psOutput.split('\n')) {
    const m = line.trim().match(/^(\d+)\s+(\d+)\s+(.*)$/);
    if (!m) continue;
    const [, pidRaw, ppidRaw, command] = m;
    if (pidRaw === undefined || ppidRaw === undefined || command === undefined) continue;
    const pid = Number.parseInt(pidRaw, 10);
    const ppid = Number.parseInt(ppidRaw, 10);
    if (ppid !== 1) continue;
    if (pid === selfPid) continue;
    if (!/node \(vitest/.test(command)) continue;
    pids.push(pid);
  }
  return pids;
}

/** 清扫孤儿 vitest worker；返回被杀掉的个数。失败一律吞掉（boot 不能被它拖住）。 */
export function sweepOrphanedTestWorkers(): number {
  let out = '';
  try {
    out = execFileSync('ps', ['-A', '-o', 'pid=,ppid=,command='], { encoding: 'utf8' });
  } catch {
    return 0;
  }
  const pids = orphanTestWorkerPids(out);
  for (const pid of pids) {
    try {
      process.kill(pid, 'SIGTERM');
    } catch {
      /* 已经退出 */
    }
  }
  if (pids.length > 0) {
    log.warn('boot', 'stray-test-workers-swept', { count: pids.length, pids });
  }
  return pids.length;
}
