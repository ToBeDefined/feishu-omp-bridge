import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { markReleaseOnline, takeReleaseOnline } from './notify';

async function tmpFile(): Promise<string> {
  return join(await mkdtemp(join(tmpdir(), 'release-notify-')), 'marker.json');
}

describe('release online marker', () => {
  it('round-trips the requesting chat id and clears the marker', async () => {
    const path = await tmpFile();
    await markReleaseOnline('oc_1', path);
    expect(await takeReleaseOnline(path)).toBe('oc_1');
    // Consumed: a second take sees nothing.
    expect(await takeReleaseOnline(path)).toBeUndefined();
  });

  it('returns undefined when no release is pending', async () => {
    expect(await takeReleaseOnline(await tmpFile())).toBeUndefined();
  });

  it('returns undefined and drops a corrupt marker instead of failing boot', async () => {
    const path = await tmpFile();
    await writeFile(path, 'not json', 'utf8');
    expect(await takeReleaseOnline(path)).toBeUndefined();
    expect(await takeReleaseOnline(path)).toBeUndefined(); // already removed
  });
});
