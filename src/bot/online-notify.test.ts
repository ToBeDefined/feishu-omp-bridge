import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  clearOnlineNotice,
  markOnlineNotice,
  onlineReasonNote,
  recentChats,
  shouldAnnounceOrdinaryBoot,
  takeOnlineNotice,
  withinAnnounceWindow,
} from './online-notify';

/** Marker + (absent) legacy path pair, so the test never touches app state. */
async function tmpPaths(): Promise<[string, string]> {
  const dir = await mkdtemp(join(tmpdir(), 'online-notify-'));
  return [join(dir, 'marker.json'), join(dir, 'legacy.json')];
}

describe('online notify marker', () => {
  it('round-trips the requesting chat id and clears the marker', async () => {
    const [path, legacy] = await tmpPaths();
    await markOnlineNotice('oc_1', 'notify', path);
    expect(await takeOnlineNotice(path, legacy)).toEqual({ chatId: 'oc_1', mode: 'notify' });
    // Consumed: a second take sees nothing.
    expect(await takeOnlineNotice(path, legacy)).toBeUndefined();
  });
  it('round-trips a skip marker for release', async () => {
    const [path, legacy] = await tmpPaths();
    await markOnlineNotice('oc_release', 'skip', path);
    expect(await takeOnlineNotice(path, legacy)).toEqual({ chatId: 'oc_release', mode: 'skip' });
  });

  it('returns undefined when no restart is pending', async () => {
    const [path, legacy] = await tmpPaths();
    expect(await takeOnlineNotice(path, legacy)).toBeUndefined();
  });

  it('returns undefined and drops a corrupt marker instead of failing boot', async () => {
    const [path, legacy] = await tmpPaths();
    await writeFile(path, 'not json', 'utf8');
    expect(await takeOnlineNotice(path, legacy)).toBeUndefined();
    expect(await takeOnlineNotice(path, legacy)).toBeUndefined(); // already removed
  });

  it('consumes a marker left under the legacy filename', async () => {
    const [path, legacy] = await tmpPaths();
    await markOnlineNotice('oc_legacy', 'notify', legacy);
    expect(await takeOnlineNotice(path, legacy)).toEqual({ chatId: 'oc_legacy', mode: 'notify' });
    expect(await takeOnlineNotice(path, legacy)).toBeUndefined();
  });

  it('prefers the current filename over a stale legacy one', async () => {
    const [path, legacy] = await tmpPaths();
    await markOnlineNotice('oc_old', 'notify', legacy);
    await markOnlineNotice('oc_new', 'notify', path);
    expect(await takeOnlineNotice(path, legacy)).toEqual({ chatId: 'oc_new', mode: 'notify' });
  });

  it('clears a marker a failed restart never consumed', async () => {
    const [path, legacy] = await tmpPaths();
    await markOnlineNotice('oc_1', 'notify', path);
    await clearOnlineNotice(path);
    expect(await takeOnlineNotice(path, legacy)).toBeUndefined();
  });

  it('tolerates clearing a marker that does not exist', async () => {
    const [path] = await tmpPaths();
    await expect(clearOnlineNotice(path)).resolves.toBeUndefined();
  });
});

describe('shouldAnnounceOrdinaryBoot（普通 boot 宣布节流）', () => {
  const T0 = 1_700_000_000_000;
  const WINDOW = 10 * 60 * 1000;

  it('首次（无记录）宣布并落时间戳；窗口内再宣布返回 false', async () => {
    const [path] = await tmpPaths();
    expect(await shouldAnnounceOrdinaryBoot(WINDOW, path, T0)).toBe(true);
    expect(await shouldAnnounceOrdinaryBoot(WINDOW, path, T0 + 60_000)).toBe(false);
  });

  it('超过窗口后重新允许宣布（避免崩溃循环里每次 boot 都刷屏）', async () => {
    const [path] = await tmpPaths();
    expect(await shouldAnnounceOrdinaryBoot(WINDOW, path, T0)).toBe(true);
    expect(await shouldAnnounceOrdinaryBoot(WINDOW, path, T0 + WINDOW + 1)).toBe(true);
  });

  it('记录损坏按「从未宣布」处理，返回 true 且不抛', async () => {
    const [path] = await tmpPaths();
    await writeFile(path, 'not json', 'utf8');
    expect(await shouldAnnounceOrdinaryBoot(WINDOW, path, T0)).toBe(true);
  });

  it('withinAnnounceWindow：缺记录=窗口外、窗口内=true、超窗口=false', () => {
    expect(withinAnnounceWindow(undefined, 1_000, 100)).toBe(false);
    expect(withinAnnounceWindow(950, 1_000, 100)).toBe(true);
    expect(withinAnnounceWindow(800, 1_000, 100)).toBe(false);
  });
});

describe('online announce targeting（只通知活跃会话）', () => {
  const DAY = 24 * 60 * 60 * 1000;

  it('recentChats：只留窗口内有活动的会话，缺时间戳视为不活跃', () => {
    const now = 1_700_000_000_000;
    const updated: Record<string, number | undefined> = {
      oc_active: now - 1000,
      oc_old: now - 8 * DAY,
      oc_missing: undefined,
    };
    expect(
      recentChats(['oc_active', 'oc_old', 'oc_missing'], (id) => updated[id], now, 7 * DAY),
    ).toEqual(['oc_active']);
  });

  it('onlineReasonNote：crash-recovery / manual（release 不广播，无此取值）', () => {
    expect(onlineReasonNote('crash-recovery')).toContain('中断');
    expect(onlineReasonNote('manual')).toContain('手动');
  });
});
