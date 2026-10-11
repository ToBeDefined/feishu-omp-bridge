import { mkdtemp, readFile, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { buildPlist, rotateDaemonStdoutIfNeeded } from './launchd';
import { supervisorGrantMarkerPath } from './macos-supervisor';

const base = {
  nodePath: '/usr/local/bin/node',
  bridgeEntryPath: '/opt/bridge/bin/feishu-omp-bridge.mjs',
  envPath: '/usr/bin:/bin',
};

function programArguments(plist: string): string[] {
  const block = plist.match(/<key>ProgramArguments<\/key>\s*<array>([\s\S]*?)<\/array>/);
  if (!block?.[1]) throw new Error('ProgramArguments missing');
  return [...block[1].matchAll(/<string>([^<]*)<\/string>/g)].map((m) => m[1] ?? '');
}

describe('launchd plist', () => {
  it('runs the bridge entry directly when no supervisor is installed', () => {
    expect(programArguments(buildPlist(base))).toEqual([
      base.nodePath,
      base.bridgeEntryPath,
      'run',
    ]);
  });

  it('runs the bridge through the supervisor app so the process tree carries a grantable identity', () => {
    const args = programArguments(buildPlist({ ...base, supervisorPath: '/app/FeishuOmpBridge' }));
    expect(args).toEqual([
      '/app/FeishuOmpBridge',
      '--marker',
      supervisorGrantMarkerPath(),
      '--',
      base.nodePath,
      base.bridgeEntryPath,
      'run',
    ]);
  });

  it('keeps PATH and log paths wired for the daemon', () => {
    const plist = buildPlist({ ...base, envPath: '/a:/b&c' });
    expect(plist).toContain('<key>PATH</key>');
    expect(plist).toContain('/a:/b&amp;c');
    expect(plist).toContain('daemon-stdout.log');
    expect(plist).toContain('daemon-stderr.log');
    expect(plist).toContain('<key>KeepAlive</key>');
  });
});

describe('rotateDaemonStdoutIfNeeded', () => {
  it('leaves files under the size threshold untouched', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'fob-rotate-'));
    const log = join(dir, 'daemon-stdout.log');
    await writeFile(log, 'recent output\n', 'utf8');
    await rotateDaemonStdoutIfNeeded(log, 1024, 4);
    expect((await stat(log)).size).toBeGreaterThan(0);
    expect(await readFile(log, 'utf8')).toBe('recent output\n');
  });

  it('copytruncates oversized logs to their tail', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'fob-rotate-'));
    const log = join(dir, 'daemon-stdout.log');
    await writeFile(log, 'x'.repeat(96) + 'TAIL', 'utf8');
    await rotateDaemonStdoutIfNeeded(log, 16, 4);
    expect(await readFile(log, 'utf8')).toBe('TAIL');
  });

  it('silently skips a missing log file', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'fob-rotate-'));
    await expect(rotateDaemonStdoutIfNeeded(join(dir, 'nope.log'), 1, 1)).resolves.toBeUndefined();
  });
});
