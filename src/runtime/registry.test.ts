import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { isAlive, readAndPrune, resolveTarget, sameAppOthers } from './registry';
import type { ProcessEntry } from './registry';

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
