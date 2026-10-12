import { execFile } from 'node:child_process';
import { describe, expect, it, vi } from 'vitest';
import { killProcessGroup, runRelease, type ReleaseExec } from './run';

// The default exec runner is the only path that spawns a real process; stub it
// so the timeout→SIGKILL-group behaviour can be asserted without side effects.
vi.mock('node:child_process', () => ({ execFile: vi.fn() }));

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

  it('reports step lifecycle via onStep', async () => {
    const { exec } = recordingExec();
    const events: Array<[string, string]> = [];
    await runRelease(exec, undefined, (step, status) => {
      events.push([step, status]);
    });
    expect(events).toEqual([
      ['typecheck', 'running'],
      ['typecheck', 'ok'],
      ['test', 'running'],
      ['test', 'ok'],
      ['build', 'running'],
      ['build', 'ok'],
    ]);
  });

  it('marks the failing step failed and stops the sequence', async () => {
    const exec = throwingExec(
      Object.assign(new Error('tsc failed'), { code: 2, stderr: 'x' }),
    );
    const events: Array<[string, string]> = [];
    await runRelease(exec, undefined, (step, status) => {
      events.push([step, status]);
    });
    expect(events).toEqual([
      ['typecheck', 'running'],
      ['typecheck', 'failed'],
    ]);
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

describe('killProcessGroup', () => {
  it('SIGKILLs the whole group via -pid', () => {
    const kill = vi.spyOn(process, 'kill').mockImplementation(() => true);
    killProcessGroup(4242);
    expect(kill).toHaveBeenCalledWith(-4242, 'SIGKILL');
    kill.mockRestore();
  });

  it('swallows ESRCH when the group is already gone', () => {
    const kill = vi.spyOn(process, 'kill').mockImplementation(() => {
      throw Object.assign(new Error('kill ESRCH'), { code: 'ESRCH' });
    });
    expect(() => killProcessGroup(1)).not.toThrow();
    kill.mockRestore();
  });
});

describe('runRelease process-group cleanup', () => {
  it('kills the spawned group with -pid when a step times out', async () => {
    const kill = vi.spyOn(process, 'kill').mockImplementation(() => true);
    let seenOpts: { detached?: boolean } | undefined;
    vi.mocked(execFile).mockImplementation(((
      _command: string,
      _args: string[],
      opts: { detached?: boolean },
      cb: (error: unknown, stdout: string, stderr: string) => void,
    ) => {
      seenOpts = opts;
      // Real execFile fires the callback asynchronously; mirror that so the
      // runner's `child.pid` is assigned before the error path reads it.
      queueMicrotask(() => {
        cb(Object.assign(new Error('killed'), { killed: true }), '', '');
      });
      return { pid: 4242 };
    }) as never);

    await expect(runRelease()).resolves.toEqual({
      ok: false,
      step: 'typecheck',
      timedOut: true,
    });
    expect(seenOpts?.detached).toBe(true);
    expect(kill).toHaveBeenCalledWith(-4242, 'SIGKILL');
    kill.mockRestore();
    vi.mocked(execFile).mockReset();
  });
});
