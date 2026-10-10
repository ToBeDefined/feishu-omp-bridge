import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { clearOnlineNotice, markOnlineNotice, takeOnlineNotice } from './online-notify';

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
