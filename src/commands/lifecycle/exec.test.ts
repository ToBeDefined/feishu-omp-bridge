import { EventEmitter } from 'node:events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Mock } from 'vitest';
import type { CommandContext } from '../index';
import { execHandlers, runCommand } from './exec';

vi.mock('node:child_process', () => ({ spawn: vi.fn() }));
vi.mock('../../core/logger', () => ({
  log: { info: vi.fn(), fail: vi.fn(), warn: vi.fn() },
}));

import { spawn } from 'node:child_process';

interface FakeChild extends EventEmitter {
  stdout: EventEmitter;
  stderr: EventEmitter;
  pid: number;
  kill: Mock;
}

function fakeChild(): FakeChild {
  const child = new EventEmitter() as FakeChild;
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.pid = 4242;
  child.kill = vi.fn();
  return child;
}

function makeCtx(): { ctx: CommandContext; sent: string[] } {
  const sent: string[] = [];
  const ctx = {
    channel: {
      send: async (_chatId: string, payload: { markdown?: string }) => {
        sent.push(payload.markdown ?? '');
      },
    },
    msg: { chatId: 'oc_1', messageId: 'om_1', content: '' },
    scope: 'oc_1',
    chatMode: 'p2p',
    sessions: {},
    workspaces: { cwdFor: () => '/home/proj' },
    agent: {},
    activeRuns: {},
    controls: {},
  } as unknown as CommandContext;
  return { ctx, sent };
}

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('runCommand', () => {
  it('collects merged stdout/stderr and exit code 0', async () => {
    const child = fakeChild();
    vi.mocked(spawn).mockReturnValue(child as never);
    const p = runCommand('echo hi', '/cwd', 30000);
    child.stdout.emit('data', Buffer.from('hi\n'));
    child.stderr.emit('data', Buffer.from('warn\n'));
    child.emit('close', 0);
    await expect(p).resolves.toEqual({ exitCode: 0, output: 'hi\nwarn\n', timedOut: false });
  });

  it('passes cwd and the shell -c string through to spawn', async () => {
    const child = fakeChild();
    vi.mocked(spawn).mockReturnValue(child as never);
    runCommand('pwd && ls', '/some/cwd', 30000);
    expect(spawn).toHaveBeenCalledWith(
      'bash',
      ['-c', 'pwd && ls'],
      expect.objectContaining({ cwd: '/some/cwd' }),
    );
    child.emit('close', 0);
  });

  it('reports a non-zero exit code', async () => {
    const child = fakeChild();
    vi.mocked(spawn).mockReturnValue(child as never);
    const p = runCommand('false', '/cwd', 30000);
    child.stderr.emit('data', Buffer.from('boom'));
    child.emit('close', 2);
    await expect(p).resolves.toEqual({ exitCode: 2, output: 'boom', timedOut: false });
  });

  it('kills the process and flags a timeout', async () => {
    vi.useFakeTimers();
    const child = fakeChild();
    vi.mocked(spawn).mockReturnValue(child as never);
    const p = runCommand('sleep 100', '/cwd', 30000);
    vi.advanceTimersByTime(30000);
    expect(child.kill).toHaveBeenCalled();
    child.emit('close', null);
    await expect(p).resolves.toMatchObject({ timedOut: true });
  });

  it('reports a spawn failure as a null exit code', async () => {
    const child = fakeChild();
    vi.mocked(spawn).mockReturnValue(child as never);
    const p = runCommand('x', '/bad-cwd', 30000);
    child.emit('error', new Error('spawn bash ENOENT'));
    await expect(p).resolves.toMatchObject({ exitCode: null, timedOut: false });
  });

  it('truncates long output to the tail', async () => {
    const child = fakeChild();
    vi.mocked(spawn).mockReturnValue(child as never);
    const p = runCommand('cat big', '/cwd', 30000);
    child.stdout.emit('data', Buffer.from('x'.repeat(1500)));
    child.emit('close', 0);
    const res = await p;
    expect(res.output).toContain('已截断');
    expect(res.output.endsWith('x'.repeat(1000))).toBe(true);
  });
});

describe('/exec', () => {
  it('aliases /run to the /exec handler', async () => {
    expect(execHandlers['/run']).toBe(execHandlers['/exec']);
    const child = fakeChild();
    vi.mocked(spawn).mockReturnValue(child as never);
    const { ctx, sent } = makeCtx();
    const p = execHandlers['/run']!('echo run-alias', ctx);
    child.stdout.emit('data', Buffer.from('run-alias'));
    child.emit('close', 0);
    await p;
    expect(sent[0]).toContain('run-alias');
  });

  it('shows usage on an empty command', async () => {
    const { ctx, sent } = makeCtx();
    await execHandlers['/exec']!('', ctx);
    expect(sent[0]).toContain('用法');
  });

  it('reports exit code 0 with output', async () => {
    const child = fakeChild();
    vi.mocked(spawn).mockReturnValue(child as never);
    const { ctx, sent } = makeCtx();
    const p = execHandlers['/exec']!('echo hi', ctx);
    child.stdout.emit('data', Buffer.from('hi'));
    child.emit('close', 0);
    await p;
    expect(sent[0]).toContain('退出码 0');
    expect(sent[0]).toContain('hi');
  });

  it('reports a timeout', async () => {
    vi.useFakeTimers();
    const child = fakeChild();
    vi.mocked(spawn).mockReturnValue(child as never);
    const { ctx, sent } = makeCtx();
    const p = execHandlers['/exec']!('sleep 100', ctx);
    vi.advanceTimersByTime(30000);
    child.emit('close', null);
    await p;
    expect(sent[0]).toContain('执行超时');
  });
});
