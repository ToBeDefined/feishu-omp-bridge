import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { userInfo } from 'node:os';
import { dirname } from 'node:path';
import { ensureSupervisorApp, supervisorGrantMarkerPath } from './macos-supervisor';
import {
  LAUNCH_AGENT_LABEL,
  daemonLogDir,
  daemonStderrPath,
  daemonStdoutPath,
  launchAgentPlistPath,
} from './paths';

export interface PlistInputs {
  /** Absolute path to the node binary that should run the bridge. */
  nodePath: string;
  /** Absolute path to the bridge CLI entry (the file currently executing). */
  bridgeEntryPath: string;
  /** PATH for the daemon process — captured from current shell so child
   * tools (lark-cli, OMP) can be resolved by name. launchd defaults
   * to a very minimal PATH otherwise. */
  envPath: string;
  /**
   * macOS only: supervisor app executable that runs the bridge as its child.
   * Without it the daemon's process identity is `node`, which macOS Local
   * Network Privacy refuses to prompt for — see macos-supervisor.ts.
   */
  supervisorPath?: string;
}

export function buildPlist(inputs: PlistInputs): string {
  const escape = (s: string): string =>
    s
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  const program = inputs.supervisorPath
    ? [
        escape(inputs.supervisorPath),
        '--marker',
        escape(supervisorGrantMarkerPath()),
        '--',
        escape(inputs.nodePath),
        escape(inputs.bridgeEntryPath),
        'run',
      ]
    : [escape(inputs.nodePath), escape(inputs.bridgeEntryPath), 'run'];
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>${LAUNCH_AGENT_LABEL}</string>
    <key>ProgramArguments</key>
    <array>
${program.map((arg) => `        <string>${arg}</string>`).join('\n')}
    </array>
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <true/>
    <key>ThrottleInterval</key>
    <integer>10</integer>
    <key>StandardOutPath</key>
    <string>${escape(daemonStdoutPath())}</string>
    <key>StandardErrorPath</key>
    <string>${escape(daemonStderrPath())}</string>
    <key>EnvironmentVariables</key>
    <dict>
        <key>PATH</key>
        <string>${escape(inputs.envPath)}</string>
    </dict>
</dict>
</plist>
`;
}

export async function writePlist(): Promise<void> {
  const bridgeEntryPath = process.argv[1];
  if (!bridgeEntryPath) {
    throw new Error('cannot determine bridge entry path (process.argv[1] is empty)');
  }
  const content = buildPlist({
    nodePath: process.execPath,
    bridgeEntryPath,
    envPath: process.env.PATH ?? '',
    supervisorPath: await ensureSupervisorApp(),
  });
  const plistPath = launchAgentPlistPath();
  await mkdir(dirname(plistPath), { recursive: true });
  await mkdir(daemonLogDir(), { recursive: true });
  await writeFile(plistPath, content, 'utf8');
}

export function plistExists(): boolean {
  return existsSync(launchAgentPlistPath());
}

function userTarget(): string {
  return `gui/${userInfo().uid}`;
}

function serviceTarget(): string {
  return `${userTarget()}/${LAUNCH_AGENT_LABEL}`;
}

interface LaunchctlResult {
  ok: boolean;
  stderr: string;
  stdout: string;
  /** Set when launchctl itself was killed by a signal before reporting. */
  signal?: string;
  /** Set when launchctl could not be spawned at all (ENOENT, …). */
  error?: string;
}

function runLaunchctl(args: string[]): LaunchctlResult {
  const r = spawnSync('launchctl', args, { encoding: 'utf8' });
  return {
    ok: r.status === 0,
    stderr: r.stderr ?? '',
    stdout: r.stdout ?? '',
    ...(r.signal ? { signal: r.signal } : {}),
    ...(r.error ? { error: r.error.message } : {}),
  };
}

export function bootstrap(): LaunchctlResult {
  return runLaunchctl(['bootstrap', userTarget(), launchAgentPlistPath()]);
}

export function bootout(): LaunchctlResult {
  return runLaunchctl(['bootout', serviceTarget()]);
}

/** kickstart -k: kill the running instance and start a new one. Service
 * must already be bootstrapped (loaded into launchd). */
export function kickstart(): LaunchctlResult {
  return runLaunchctl(['kickstart', '-k', serviceTarget()]);
}

/** `launchctl print <target>` returns 0 iff the service is loaded.
 * We discard the verbose stdout for the existence check. */
export function isLoaded(): boolean {
  const r = spawnSync('launchctl', ['print', serviceTarget()], {
    stdio: ['ignore', 'ignore', 'ignore'],
  });
  return r.status === 0;
}

/**
 * launchctl bootout returns synchronously, but the actual unload is async
 * at the OS level — `isLoaded()` may still be true for a brief window
 * after. If you bootstrap during that window, launchd refuses with the
 * cryptic `Bootstrap failed: 5: Input/output error`. Poll until the
 * service is truly gone.
 */
export async function waitUntilUnloaded(timeoutMs = 5000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!isLoaded()) return true;
    await new Promise((r) => setTimeout(r, 200));
  }
  return false;
}

/** Returns the raw `launchctl print` output, parsed downstream. */
export function describeService(): string {
  const r = runLaunchctl(['print', serviceTarget()]);
  return r.stdout || r.stderr || '';
}

export async function deletePlist(): Promise<void> {
  await rm(launchAgentPlistPath(), { force: true });
}
