import { existsSync, mkdtempSync, readFileSync, unlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import {
  cleanupTmpFiles,
  isAlive,
  readAndPrune,
  register,
  resolveTarget,
  sameAppOthers,
  sweepStaleTmpFiles,
  unregister,
  unregisterSync,
  updateEntry,
  withRegistryLock,
} from './registry';
import type { ProcessEntry } from './registry';

const delay = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

function file(): string {
  const d = mkdtempSync(join(tmpdir(), 'registry-test-'));
  return join(d, 'processes.json');
}
function write(entries: ProcessEntry[]): string {
  const f = file();
  writeFileSync(f, JSON.stringify({ entries }));
  return f;
}
function entry(over: Partial<ProcessEntry> = {}): ProcessEntry {
  return {
    id: 'ab12',
    pid: 99999,
    appId: 'cli_app',
    tenant: 'feishu',
    configPath: '/tmp/config.json',
    startedAt: '2026-08-17T00:00:00.000Z',
    version: '0.1.0',
    ...over,
  };
}

// 真实 pid 语义：当前进程必然存活，99999999 必然不存在
const LIVE_PID = process.pid;
const DEAD_PID = 99999999;

describe('readAndPrune', () => {
  it('drops entries whose pid is no longer alive', () => {
    const f = write([entry({ id: 'dead', pid: DEAD_PID }), entry({ id: 'live', pid: LIVE_PID })]);
    const out = readAndPrune(f);
    expect(out.map((e) => e.id)).toEqual(['live']);
  });

  it('keeps all entries when every pid is alive', () => {
    const f = write([entry({ id: 'a', pid: LIVE_PID }), entry({ id: 'b', pid: LIVE_PID })]);
    expect(readAndPrune(f)).toHaveLength(2);
  });

  it('returns empty for missing file', () => {
    expect(readAndPrune(join(tmpdir(), 'nope', 'x.json'))).toEqual([]);
  });

  it('returns empty for malformed content', () => {
    const d = mkdtempSync(join(tmpdir(), 'registry-test-'));
    const f = join(d, 'processes.json');
    writeFileSync(f, 'not json');
    expect(readAndPrune(f)).toEqual([]);
  });

  it('returns empty for non-array entries field', () => {
    const d = mkdtempSync(join(tmpdir(), 'registry-test-'));
    const f = join(d, 'processes.json');
    writeFileSync(f, '{"entries":{}}');
    expect(readAndPrune(f)).toEqual([]);
  });

  it('drops invalid entries (wrong shape) even when pid alive', () => {
    const d = mkdtempSync(join(tmpdir(), 'registry-test-'));
    const f = join(d, 'processes.json');
    writeFileSync(
      f,
      JSON.stringify({
        entries: [
          { id: 'bad', pid: LIVE_PID }, // 缺 appId/tenant/... → 非法
          entry({ id: 'good', pid: LIVE_PID }),
        ],
      }),
    );
    const out = readAndPrune(f);
    expect(out.map((e) => e.id)).toEqual(['good']);
  });
});

describe('isAlive', () => {
  it('returns true for current process', () => {
    expect(isAlive(LIVE_PID)).toBe(true);
  });

  it('returns false for nonexistent pid', () => {
    expect(isAlive(DEAD_PID)).toBe(false);
  });
});

describe('sameAppOthers', () => {
  it('includes only same-app entries with a different pid', () => {
    const f = write([
      entry({ id: 'a', appId: 'app1', pid: LIVE_PID }),
      entry({ id: 'b', appId: 'app1', pid: DEAD_PID }),
      entry({ id: 'c', appId: 'app2', pid: LIVE_PID }),
    ]);
    // b 死 pid 被 prune；a 同 app 但 pid==excludePid 排除；c 不同 app
    expect(sameAppOthers('app1', LIVE_PID, f)).toEqual([]);
  });

  it('keeps same-app live entry when pid differs', () => {
    const f = write([entry({ id: 'a', appId: 'app1', pid: LIVE_PID })]);
    expect(sameAppOthers('app1', 12345, f).map((e) => e.id)).toEqual(['a']);
  });
});

describe('resolveTarget', () => {
  it('resolves by short id', () => {
    const f = write([entry({ id: 'aa', pid: LIVE_PID }), entry({ id: 'bb', pid: LIVE_PID })]);
    expect(resolveTarget('bb', f)?.id).toBe('bb');
  });

  it('resolves by 1-based index', () => {
    const f = write([entry({ id: 'aa', pid: LIVE_PID }), entry({ id: 'bb', pid: LIVE_PID })]);
    expect(resolveTarget('1', f)?.id).toBe('aa');
    expect(resolveTarget('2', f)?.id).toBe('bb');
  });

  it('returns undefined for unknown / out-of-range / invalid index', () => {
    const f = write([entry({ id: 'aa', pid: LIVE_PID })]);
    expect(resolveTarget('zz', f)).toBeUndefined();
    expect(resolveTarget('5', f)).toBeUndefined();
    expect(resolveTarget('0', f)).toBeUndefined();
    expect(resolveTarget('abc', f)).toBeUndefined();
  });
});

// 锁测试快跑参数：真实默认值（50ms/2s/5s）会拖慢测试，这里用同构的小值。
const FAST = { retryMs: 5, timeoutMs: 1_000, staleMs: 60_000 } as const;

describe('withRegistryLock（跨进程锁）', () => {
  it('串行化两个竞争者：后者在前者释放前不得进入', async () => {
    vi.useFakeTimers();
    try {
      const f = file();
      const order: string[] = [];
      let release!: () => void;
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });

      const a = withRegistryLock(
        f,
        async () => {
          order.push('a:start');
          await gate;
          order.push('a:end');
        },
        FAST,
      );
      // 首次获锁是同步完成的：a 已持锁并进入 fn
      expect(order).toEqual(['a:start']);

      const b = withRegistryLock(f, async () => order.push('b'), FAST);
      // 虚拟时钟不走真实时间：b 必然还在锁外打转
      expect(order).toEqual(['a:start']);

      release();
      await vi.advanceTimersByTimeAsync(FAST.retryMs); // 泵动 b 的下一次轮询
      await Promise.all([a, b]);
      expect(order).toEqual(['a:start', 'a:end', 'b']);
      expect(existsSync(`${f}.lock`)).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it('陈旧锁（mtime 超过阈值）被直接接管，无需等待', async () => {
    const f = file();
    const lock = `${f}.lock`;
    writeFileSync(lock, '424242\n'); // 崩溃进程（kill -9）残留
    const past = new Date(Date.now() - 5_000);
    utimesSync(lock, past, past);

    await withRegistryLock(
      f,
      async () => {
        // 首次尝试即接管成功，锁文件里已是本进程 pid
        expect(readFileSync(lock, 'utf8')).toContain(String(process.pid));
      },
      { retryMs: 5, timeoutMs: 1_000, staleMs: 1_000 },
    );
    expect(existsSync(lock)).toBe(false);
  });

  it('新鲜残留锁不被抢占，超过 timeout 抛错（宁可失败不可无锁裸写）', async () => {
    vi.useFakeTimers();
    try {
      const f = file();
      writeFileSync(`${f}.lock`, '424242\n');
      const attempt = withRegistryLock(f, async () => {}, { ...FAST, timeoutMs: 50 });
      const expectation = expect(attempt).rejects.toThrow(/lock busy/);
      await vi.advanceTimersByTimeAsync(100);
      await expectation;
      // 抛错路径不碰注册表文件
      expect(existsSync(f)).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it('fn 抛错也在 finally 释放锁，后续可立即获锁', async () => {
    const f = file();
    await expect(
      withRegistryLock(
        f,
        async () => {
          throw new Error('boom');
        },
        FAST,
      ),
    ).rejects.toThrow('boom');
    await expect(withRegistryLock(f, async () => 'ok', FAST)).resolves.toBe('ok');
    expect(existsSync(`${f}.lock`)).toBe(false);
  });
});

describe('注册表写路径走跨进程锁', () => {
  it('register 写入 entry，结束后锁文件已清理', async () => {
    const f = file();
    const e = await register(
      { appId: 'cli_a', tenant: 'feishu', configPath: '/tmp/c.json', version: '0.1.0' },
      f,
    );
    expect(e.pid).toBe(process.pid);
    const onDisk = JSON.parse(readFileSync(f, 'utf8')) as { entries: ProcessEntry[] };
    expect(onDisk.entries.map((x) => x.id)).toEqual([e.id]);
    expect(existsSync(`${f}.lock`)).toBe(false);
  });

  it('updateEntry / unregister 经锁改写目标 entry', async () => {
    const f = write([entry({ id: 'aa', pid: LIVE_PID })]);
    await updateEntry('aa', { botName: '尼莫' }, f);
    expect(readAndPrune(f).find((e) => e.id === 'aa')?.botName).toBe('尼莫');
    await unregister('aa', f);
    expect(readAndPrune(f)).toEqual([]);
    expect(existsSync(`${f}.lock`)).toBe(false);
  });

  it('unregisterSync（exit 路径）：锁被占时静默放弃，拿到锁后删除', () => {
    const f = write([entry({ id: 'aa', pid: LIVE_PID })]);
    writeFileSync(`${f}.lock`, '424242\n'); // 别人持有新鲜锁
    expect(() => unregisterSync('aa', f)).not.toThrow();
    expect(readAndPrune(f)).toHaveLength(1); // 文件未被触碰；死 pid 稍后由他人 prune
    unlinkSync(`${f}.lock`);
    unregisterSync('aa', f);
    expect(readAndPrune(f)).toEqual([]);
    expect(existsSync(`${f}.lock`)).toBe(false);
  });
});

describe('sweepStaleTmpFiles / cleanupTmpFiles（tmp 垃圾清扫）', () => {
  it('sweepStaleTmpFiles 删掉超龄的两种命名 tmp，保留新鲜与无关文件', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'sweep-'));
    // 两种命名：`.tmp-<pid>-<hex>`（registry/config/keystore）与 `.<pid>.tmp`（running-cards）
    const stale1 = join(dir, 'processes.json.tmp-1234-deadbeef');
    const stale2 = join(dir, 'running-cards.json.1234.tmp');
    const fresh = join(dir, 'config.json.tmp-1-ffff');
    const keep = join(dir, 'processes.json');
    const lock = join(dir, 'processes.json.lock');
    for (const p of [stale1, stale2, fresh, keep, lock]) writeFileSync(p, 'x');
    const past = new Date(Date.now() - 60_000);
    utimesSync(stale1, past, past);
    utimesSync(stale2, past, past);

    expect(await sweepStaleTmpFiles(dir, 30_000)).toBe(2);
    expect(existsSync(stale1)).toBe(false);
    expect(existsSync(stale2)).toBe(false);
    expect(existsSync(fresh)).toBe(true); // 窗口内：可能是活进程在途的 tmp
    expect(existsSync(keep)).toBe(true);
    expect(existsSync(lock)).toBe(true);
  });

  it('sweepStaleTmpFiles 对不存在的目录返回 0，不抛', async () => {
    expect(await sweepStaleTmpFiles(join(tmpdir(), 'no-such-sweep-dir'), 1_000)).toBe(0);
  });

  it('cleanupTmpFiles 按模式清本进程的随机后缀 tmp（旧的定名 unlink 匹配不到 → 每崩一次漏一个）', () => {
    const dir = mkdtempSync(join(tmpdir(), 'cleanup-'));
    const mine1 = join(dir, `processes.json.tmp-${process.pid}-deadbeef`);
    const mine2 = join(dir, `running-cards.json.${process.pid}.tmp`);
    const mine3 = join(dir, `workspaces.json.tmp-${process.pid}`);
    const other = join(dir, 'processes.json.tmp-99999-aaaa'); // 别的进程，不得误删
    for (const p of [mine1, mine2, mine3, other]) writeFileSync(p, 'x');

    cleanupTmpFiles(dir);

    expect(existsSync(mine1)).toBe(false);
    expect(existsSync(mine2)).toBe(false);
    expect(existsSync(mine3)).toBe(false);
    expect(existsSync(other)).toBe(true);
  });

  it('cleanupTmpFiles 对不存在的目录不抛（exit 路径）', () => {
    expect(() => cleanupTmpFiles(join(tmpdir(), 'no-such-cleanup-dir'))).not.toThrow();
  });
});
