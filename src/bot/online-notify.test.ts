import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { clearOnlineNotify, markOnlineNotify, takeOnlineNotify } from './online-notify';

/** Marker + (absent) legacy path pair, so the test never touches app state. */
async function tmpPaths(): Promise<[string, string]> {
  const dir = await mkdtemp(join(tmpdir(), 'online-notify-'));
  return [join(dir, 'marker.json'), join(dir, 'legacy.json')];
}

describe('online notify marker', () => {
  it('round-trips the requesting chat id and clears the marker', async () => {
    const [path, legacy] = await tmpPaths();
    await markOnlineNotify('oc_1', path);
    expect(await takeOnlineNotify(path, legacy)).toBe('oc_1');
    // Consumed: a second take sees nothing.
    expect(await takeOnlineNotify(path, legacy)).toBeUndefined();
  });

  it('returns undefined when no restart is pending', async () => {
    const [path, legacy] = await tmpPaths();
    expect(await takeOnlineNotify(path, legacy)).toBeUndefined();
  });

  it('returns undefined and drops a corrupt marker instead of failing boot', async () => {
    const [path, legacy] = await tmpPaths();
    await writeFile(path, 'not json', 'utf8');
    expect(await takeOnlineNotify(path, legacy)).toBeUndefined();
    expect(await takeOnlineNotify(path, legacy)).toBeUndefined(); // already removed
  });

  it('consumes a marker left under the legacy filename', async () => {
    const [path, legacy] = await tmpPaths();
    await markOnlineNotify('oc_legacy', legacy);
    expect(await takeOnlineNotify(path, legacy)).toBe('oc_legacy');
    expect(await takeOnlineNotify(path, legacy)).toBeUndefined();
  });

  it('prefers the current filename over a stale legacy one', async () => {
    const [path, legacy] = await tmpPaths();
    await markOnlineNotify('oc_old', legacy);
    await markOnlineNotify('oc_new', path);
    expect(await takeOnlineNotify(path, legacy)).toBe('oc_new');
  });

  it('clears a marker a failed restart never consumed', async () => {
    const [path, legacy] = await tmpPaths();
    await markOnlineNotify('oc_1', path);
    await clearOnlineNotify(path);
    expect(await takeOnlineNotify(path, legacy)).toBeUndefined();
  });

  it('tolerates clearing a marker that does not exist', async () => {
    const [path] = await tmpPaths();
    await expect(clearOnlineNotify(path)).resolves.toBeUndefined();
  });
});
