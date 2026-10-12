import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, open, rm, stat, writeFile } from 'node:fs/promises';
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
  // FOB_SUPERVISED 只在**真的**由 supervisor app 拉起时设置：进程的孤儿自检
  // （ppid===1 ⇒ supervisor 已死 ⇒ 退出）依赖这个标记。若 swiftc/签名不可用而
  // 回退成 launchd 直拉 node，则父进程本来就是 launchd(1)，误标会让守护进程在
  // 每次启动 5 秒后自杀。
  const supervisedEnv = inputs.supervisorPath
    ? `
        <key>FOB_SUPERVISED</key>
        <string>1</string>
`
    : '';
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
    <key>ExitTimeOut</key>
    <integer>8</integer>
    <key>StandardOutPath</key>
    <string>${escape(daemonStdoutPath())}</string>
    <key>StandardErrorPath</key>
    <string>${escape(daemonStderrPath())}</string>
    <key>EnvironmentVariables</key>
    <dict>
        <key>PATH</key>
        <string>${escape(inputs.envPath)}</string>${supervisedEnv}</dict>
</dict>
</plist>
`;
}

async function writePlistFile(): Promise<void> {
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

export async function writePlist(): Promise<void> {
  await writePlistFile();
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

/** daemon-stdout.log 超过该字节数时轮转（copytruncate：launchd 持有同一
 * inode 的 fd，只有原地把文件截断重写才不会让 launchd 继续写旧句柄）。 */
export const DAEMON_STDOUT_MAX_BYTES = 20 * 1024 * 1024;
/** 轮转时保留的尾部字节数 —— 最近的日志最值得排查。 */
const ROTATE_TAIL_BYTES = 1024 * 1024;

/**
 * daemon-stdout.log 无轮转、会无限增长。boot 时调用一次：超过 maxBytes 时
 * 原地 copytruncate —— 读取尾部 tailBytes 并重写文件（同一 inode，launchd
 * 的 stdout fd 继续有效）。文件不存在时静默跳过。
 */
export async function rotateDaemonStdoutIfNeeded(
  stdoutPath: string = daemonStdoutPath(),
  maxBytes: number = DAEMON_STDOUT_MAX_BYTES,
  tailBytes: number = ROTATE_TAIL_BYTES,
): Promise<void> {
  let size: number;
  try {
    size = (await stat(stdoutPath)).size;
  } catch {
    return; // 没有日志文件就没有可轮转的东西
  }
  if (size <= maxBytes) return;
  const start = Math.max(0, size - tailBytes);
  const length = size - start;
  const handle = await open(stdoutPath, 'r');
  try {
    const tail = Buffer.alloc(length);
    await handle.read(tail, 0, length, start);
    await writeFile(stdoutPath, tail); // flag 'w'：截断后重写
  } finally {
    await handle.close();
  }
}

/**
 * stdout 与 stderr 两份日志都做 copytruncate 轮转（阈值、尾部与
 * rotateDaemonStdoutIfNeeded 一致）。文件不存在时静默跳过。
 *
 * 参数可选，方便测试；生产调用不带参数即用默认阈值。
 */
export async function rotateDaemonLogsIfNeeded(
  maxBytes: number = DAEMON_STDOUT_MAX_BYTES,
  tailBytes: number = ROTATE_TAIL_BYTES,
): Promise<void> {
  await rotateDaemonStdoutIfNeeded(daemonStdoutPath(), maxBytes, tailBytes);
  await rotateDaemonStdoutIfNeeded(daemonStderrPath(), maxBytes, tailBytes);
}

/**
 * 桥内重启路径（`/restart`、`/release` 经 ctx.controls.restartProcess()）：
 * kickstart 之前先把 plist 重写一遍，确保升级后新的 ProgramArguments /
 * EnvironmentVariables 被 launchd 采纳。跑在 daemon 进程里，直接写文件，
 * 不要再起 CLI 子进程。重写失败只告警、不阻断 —— 旧 plist 仍能 kickstart。
 */
export async function rewritePlistThenKickstart(): Promise<LaunchctlResult> {
  try {
    await writePlist();
  } catch (err) {
    console.warn('[restart] plist 重写失败（忽略，继续 kickstart）:', err);
  }
  return kickstart();
}
