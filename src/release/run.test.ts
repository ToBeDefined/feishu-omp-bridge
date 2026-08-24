import { describe, expect, it } from 'vitest';
import { runRelease, type ReleaseExec } from './run';

function recordingExec(): { exec: ReleaseExec; calls: string[] } {
  const calls: string[] = [];
  const exec: ReleaseExec = async (_command, args) => {
    calls.push(args[0] ?? '');
    return { stdout: '', stderr: '' };
  };
  return { exec, calls };
}

function throwingExec(err: unknown): ReleaseExec {
  return async () => {
    throw err;
  };
}

describe('runRelease', () => {
  it('runs typecheck, test, build in order and succeeds', async () => {
    const { exec, calls } = recordingExec();
    await expect(runRelease(exec)).resolves.toEqual({ ok: true });
    expect(calls).toEqual(['typecheck', 'test', 'build']);
  });

  it('stops at a typecheck failure and reports exit code + output', async () => {
    const exec = throwingExec(
      Object.assign(new Error('tsc failed'), { code: 2, stderr: 'error TS1234: x' }),
    );
    await expect(runRelease(exec)).resolves.toEqual({
      ok: false,
      step: 'typecheck',
      exitCode: 2,
      output: 'error TS1234: x',
    });
  });

  it('passes earlier steps and stops at the failing one', async () => {
    const exec: ReleaseExec = async (_command, args) => {
      if (args[0] === 'test') {
        throw Object.assign(new Error('test failed'), { code: 1, stderr: '2 failed' });
      }
      return { stdout: '', stderr: '' };
    };
    await expect(runRelease(exec)).resolves.toEqual({
      ok: false,
      step: 'test',
      exitCode: 1,
      output: '2 failed',
    });
  });

  it('reports pnpm missing on ENOENT', async () => {
    const exec = throwingExec(Object.assign(new Error('spawn ENOENT'), { code: 'ENOENT' }));
    await expect(runRelease(exec)).resolves.toEqual({
      ok: false,
      step: 'typecheck',
      pnpmMissing: true,
    });
  });

  it('reports timeout when a step is killed', async () => {
    const exec = throwingExec(Object.assign(new Error('killed'), { killed: true }));
    await expect(runRelease(exec)).resolves.toEqual({
      ok: false,
      step: 'typecheck',
      timedOut: true,
    });
  });

  it('truncates long failure output to the tail', async () => {
    const long = 'x'.repeat(2500);
    const exec = throwingExec(Object.assign(new Error('boom'), { code: 1, stderr: long }));
    const res = await runRelease(exec);
    expect(res.ok).toBe(false);
    expect(res.output).toHaveLength(2000);
    expect(res.output).toBe(long.slice(-2000));
  });
  it('passes cwd through to the exec runner', async () => {
    const seen: Array<string | undefined> = [];
    const exec: ReleaseExec = async (_command, _args, options) => {
      seen.push(options.cwd);
      return { stdout: '', stderr: '' };
    };
    await runRelease(exec, '/repo/root');
    expect(seen.every((cwd) => cwd === '/repo/root')).toBe(true);
  });
});
