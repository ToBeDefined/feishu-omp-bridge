import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';

export interface ReleaseExecOptions {
  timeout: number;
  cwd?: string;
}

/** Subprocess runner contract, injectable for tests. */
export type ReleaseExec = (
  command: string,
  args: string[],
  options: ReleaseExecOptions,
) => Promise<{ stdout: string; stderr: string }>;

export interface ReleaseStep {
  name: 'typecheck' | 'test' | 'build';
  args: string[];
  timeoutMs: number;
}

/** The standard self-release pipeline. Fails fast: any non-zero step stops
 *  the sequence and leaves the running process untouched. */
export const RELEASE_STEPS: readonly ReleaseStep[] = [
  { name: 'typecheck', args: ['typecheck'], timeoutMs: 60_000 },
  { name: 'test', args: ['test'], timeoutMs: 120_000 },
  { name: 'build', args: ['build'], timeoutMs: 120_000 },
];

export interface ReleaseResult {
  ok: boolean;
  /** The step that failed, when `ok` is false. */
  step?: ReleaseStep['name'];
  /** Non-zero exit code of the failing step, when known. */
  exitCode?: number;
  /** Truncated tail of the failing step's output. */
  output?: string;
  /** True when a step ran past its timeout. */
  timedOut?: boolean;
  /** True when `pnpm` itself could not be resolved (ENOENT). */
  pnpmMissing?: boolean;
}

const OUTPUT_TAIL = 2000;
const MAX_BUFFER = 8 * 1024 * 1024;

interface ExecError extends Error {
  code?: number | string;
  killed?: boolean;
  stdout?: string;
  stderr?: string;
}

/** execFile wrapped so captured stdout/stderr are surfaced on rejection. */
const execFileAsync: ReleaseExec = (command, args, options) =>
  new Promise((resolvePromise, rejectPromise) => {
    execFile(command, args, { ...options, maxBuffer: MAX_BUFFER }, (error, stdout, stderr) => {
      if (error) {
        const e = error as ExecError;
        e.stdout = stdout;
        e.stderr = stderr;
        rejectPromise(e);
        return;
      }
      resolvePromise({ stdout, stderr });
    });
  });

/** The repo root. When bundled, import.meta.url is `<repo>/dist/cli.js`,
 *  so `..` is the repo root. The bridge daemon's process.cwd() is `/`
 *  (launchd default), so callers must pass an explicit cwd to `pnpm`. */
export function repoRoot(): string {
  return fileURLToPath(new URL('..', import.meta.url));
}

export async function runRelease(
  exec: ReleaseExec = execFileAsync,
  cwd?: string,
): Promise<ReleaseResult> {
  for (const step of RELEASE_STEPS) {
    try {
      await exec('pnpm', step.args, { timeout: step.timeoutMs, cwd });
    } catch (err) {
      const e = err as ExecError;
      if (e.code === 'ENOENT') {
        return { ok: false, step: step.name, pnpmMissing: true };
      }
      if (e.killed) {
        return { ok: false, step: step.name, timedOut: true };
      }
      const raw = e.stderr ?? e.stdout ?? '';
      return {
        ok: false,
        step: step.name,
        exitCode: typeof e.code === 'number' ? e.code : undefined,
        output: raw.length > OUTPUT_TAIL ? raw.slice(-OUTPUT_TAIL) : raw,
      };
    }
  }
  return { ok: true };
}
