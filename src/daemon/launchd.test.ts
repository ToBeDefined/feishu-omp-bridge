import { mkdir, mkdtemp, readFile, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { buildPlist, rotateDaemonLogsIfNeeded, rotateDaemonStdoutIfNeeded } from './launchd';
import { supervisorGrantMarkerPath } from './macos-supervisor';
import { daemonStderrPath, daemonStdoutPath } from './paths';

const SUPERVISOR_PATH = '/Applications/FeishuOmpBridge.app/Contents/MacOS/FeishuOmpBridgeSupervisor';

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

  it('sets ExitTimeOut (launchd 等 8s 再 SIGKILL) 且 supervisor 形态下带 FOB_SUPERVISED', () => {
    const plist = buildPlist({ ...base, supervisorPath: SUPERVISOR_PATH });
    expect(plist).toMatch(/<key>ExitTimeOut<\/key>\s*<integer>8<\/integer>/);
    expect(plist).toMatch(/<key>FOB_SUPERVISED<\/key>\s*<string>1<\/string>/);
    expect(plist).toContain(SUPERVISOR_PATH);
  });
});

describe('FOB_SUPERVISED 标记的准确性', () => {
  it('走 supervisor 时设置 FOB_SUPERVISED', () => {
    const plist = buildPlist({ ...base, supervisorPath: SUPERVISOR_PATH });
    expect(plist).toContain('FOB_SUPERVISED');
    expect(plist).toContain(SUPERVISOR_PATH);
  });

  it('回退直拉 node 时**不设置**（否则父进程是 launchd(1) → 守护进程会自杀）', () => {
    const plist = buildPlist(base);
    expect(plist).not.toContain('FOB_SUPERVISED');
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

describe('rotateDaemonLogsIfNeeded', () => {
  it('copytruncates both stdout and stderr past the threshold', async () => {
    await mkdir(dirname(daemonStdoutPath()), { recursive: true });
    await writeFile(daemonStdoutPath(), 'x'.repeat(96) + 'OUT', 'utf8');
    await writeFile(daemonStderrPath(), 'y'.repeat(96) + 'ERR', 'utf8');
    await rotateDaemonLogsIfNeeded(16, 3);
    expect(await readFile(daemonStdoutPath(), 'utf8')).toBe('OUT');
    expect(await readFile(daemonStderrPath(), 'utf8')).toBe('ERR');
  });

  it('rotates stderr even when stdout is under the threshold', async () => {
    await mkdir(dirname(daemonStderrPath()), { recursive: true });
    await writeFile(daemonStdoutPath(), 'small\n', 'utf8');
    await writeFile(daemonStderrPath(), 'y'.repeat(96) + 'ERR', 'utf8');
    await rotateDaemonLogsIfNeeded(16, 3);
    expect(await readFile(daemonStdoutPath(), 'utf8')).toBe('small\n');
    expect(await readFile(daemonStderrPath(), 'utf8')).toBe('ERR');
  });

  it('silently skips when neither log file exists', async () => {
    await expect(rotateDaemonLogsIfNeeded(1, 1)).resolves.toBeUndefined();
  });
});
