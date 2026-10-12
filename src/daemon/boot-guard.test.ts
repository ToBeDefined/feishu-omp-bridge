import { readFile, rm, writeFile } from 'node:fs/promises';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  BOOT_ATTEMPTS_FILE,
  autoRestartExhausted,
  bootFailureCount,
  clearBootFailures,
  noteBootFailure,
  noteBootSuccess,
  shouldTrip,
  type BootFailure,
} from './boot-guard';

/** Fixed clock origin so window math is exact and deterministic. */
const T0 = Date.parse('2026-01-01T00:00:00.000Z');

const at = (offsetMs: number): BootFailure => ({
  at: new Date(T0 + offsetMs).toISOString(),
  reason: 'test',
});

beforeEach(async () => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date(T0));
  await rm(BOOT_ATTEMPTS_FILE, { force: true });
});

afterEach(async () => {
  vi.useRealTimers();
  await rm(BOOT_ATTEMPTS_FILE, { force: true });
});

describe('shouldTrip（纯函数）', () => {
  it('窗口内达到阈值才算熔断', () => {
    const failures = [at(-1), at(-2), at(-3), at(-4), at(-5)];
    expect(shouldTrip(failures, T0, { threshold: 5, windowMs: 60_000 })).toBe(true);
    expect(shouldTrip(failures.slice(0, 4), T0, { threshold: 5, windowMs: 60_000 })).toBe(false);
  });

  it('滑出窗口的失败不计入', () => {
    const failures = [at(-1), at(-2), at(-3), at(-4), at(-20_000)];
    expect(shouldTrip(failures, T0, { threshold: 5, windowMs: 10_000 })).toBe(false);
  });

  it('非法时间戳被忽略（不误判为熔断）', () => {
    const failures: BootFailure[] = [
      { at: 'not-a-date', reason: 'x' },
      { at: 'not-a-date', reason: 'y' },
    ];
    expect(shouldTrip(failures, T0, { threshold: 1, windowMs: 10_000 })).toBe(false);
  });
});

describe('boot-guard 持久化', () => {
  it('noteBootFailure 累积失败，达到阈值后熔断', async () => {
    for (let i = 0; i < 5; i++) await noteBootFailure('boom');
    expect(await bootFailureCount()).toBe(5);
    expect(await autoRestartExhausted()).toBe(true); // 默认阈值 5 / 窗口 10 分钟
  });

  it('失败次数未达阈值不熔断', async () => {
    for (let i = 0; i < 4; i++) await noteBootFailure('boom');
    expect(await autoRestartExhausted()).toBe(false);
  });

  it('窗口外的旧失败在写入时被剪掉', async () => {
    await noteBootFailure('old');
    vi.setSystemTime(new Date(T0 + 11 * 60 * 1000)); // 超过默认 10 分钟窗口
    await noteBootFailure('new');
    expect(await bootFailureCount()).toBe(1);
    expect(await autoRestartExhausted()).toBe(false);
  });

  it('noteBootSuccess 清零失败计数但保留 lastSuccessAt', async () => {
    await noteBootFailure('a');
    await noteBootFailure('b');
    await noteBootSuccess();
    expect(await bootFailureCount()).toBe(0);
    expect(await autoRestartExhausted()).toBe(false);
    const raw = JSON.parse(await readFile(BOOT_ATTEMPTS_FILE, 'utf8')) as {
      lastSuccessAt?: unknown;
    };
    expect(typeof raw.lastSuccessAt).toBe('string');
  });

  it('clearBootFailures 清空失败但保留 lastSuccessAt', async () => {
    await noteBootSuccess();
    await noteBootFailure('x');
    await clearBootFailures();
    expect(await bootFailureCount()).toBe(0);
    const raw = JSON.parse(await readFile(BOOT_ATTEMPTS_FILE, 'utf8')) as {
      lastSuccessAt?: unknown;
    };
    expect(typeof raw.lastSuccessAt).toBe('string');
  });

  it('损坏 / 形状错误的状态文件当作空容忍', async () => {
    await writeFile(BOOT_ATTEMPTS_FILE, '{ not json', 'utf8');
    expect(await bootFailureCount()).toBe(0);
    expect(await autoRestartExhausted()).toBe(false);

    await writeFile(
      BOOT_ATTEMPTS_FILE,
      JSON.stringify({ failures: 'nope', lastSuccessAt: 123 }),
      'utf8',
    );
    expect(await bootFailureCount()).toBe(0);
    expect(await autoRestartExhausted()).toBe(false);
  });
});
