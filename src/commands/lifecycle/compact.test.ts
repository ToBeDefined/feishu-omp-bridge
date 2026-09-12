import { chmod, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ActiveRuns } from '../../bot/active-runs';
import { OmpAdapter } from '../../agent/omp/adapter';
import { compactHandlers } from './compact';
import type { CommandContext } from '../index';

async function fakeOmp(source: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'omp-compact-test-'));
  const path = join(dir, 'omp-fake.mjs');
  await writeFile(path, `#!/usr/bin/env node\n${source}`, 'utf8');
  await chmod(path, 0o700);
  return path;
}

function makeCtx(overrides: {
  activeRuns?: ActiveRuns;
  compactSession?: (opts: { sessionId: string; cwd?: string; model?: string; customInstructions?: string; timeoutMs?: number; signal?: AbortSignal }) => Promise<string | undefined>;
  cwd?: string;
  sessionId?: string;
  sessionDir?: string;
}): CommandContext {
  const send = vi.fn(async () => {});
  return {
    channel: { send },
    msg: { chatId: 'oc_1', messageId: 'om_1', content: '' },
    scope: 'oc_1',
    chatMode: 'p2p',
    workspaces: { cwdFor: () => overrides.cwd ?? '/repo' },
    sessions: { resumeFor: () => overrides.sessionId },
    activeRuns: overrides.activeRuns ?? new ActiveRuns(),
    agent: { compactSession: overrides.compactSession },
    controls: {
      cfg: {
        preferences: { ompSessionDir: overrides.sessionDir ?? '/nonexistent-omp-bridge-test' },
      },
    },
  } as unknown as CommandContext;
}

interface SendCall {
  markdown?: string;
}

function sentBodies(ctx: CommandContext): string[] {
  const send = ctx.channel.send as unknown as { mock: { calls: Array<[unknown, SendCall]> } };
  return send.mock.calls.map((c) => c[1].markdown ?? '');
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('/compact command', () => {
  it('queues compact until the active run finishes', async () => {
    const activeRuns = new ActiveRuns();
    const compactSession = vi.fn(async () => undefined);
    const ctx = makeCtx({ activeRuns, compactSession, sessionId: 's1' });
    const run = { events: (async function* () {})(), stop: async () => {}, waitForExit: async () => true };
    activeRuns.register('oc_1', run);

    await compactHandlers['/compact']!('keep the last question', ctx);

    expect(compactSession).not.toHaveBeenCalled();
    expect(sentBodies(ctx).join('\n')).toContain('任务结束后');

    activeRuns.unregister('oc_1', run);
    await vi.waitFor(() => expect(compactSession).toHaveBeenCalled());
    expect(compactSession).toHaveBeenCalledWith(expect.objectContaining({
      sessionId: 's1',
      cwd: '/repo',
      model: undefined,
      customInstructions: 'keep the last question',
      timeoutMs: 600_000,
    }));
  });

  it('compacts the persisted session when idle', async () => {
    const compactSession = vi.fn(async () => undefined);
    const ctx = makeCtx({ compactSession, cwd: '/repo', sessionId: 's1' });

    await compactHandlers['/compact']!('keep the last question', ctx);

    expect(compactSession).toHaveBeenCalledWith(expect.objectContaining({
      sessionId: 's1',
      cwd: '/repo',
      model: undefined,
      customInstructions: 'keep the last question',
      timeoutMs: 600_000,
    }));
    const bodies = sentBodies(ctx).join('\n');
    expect(bodies).toContain('正在压缩');
    expect(bodies).toContain('✅');
  });

  it('reports the error from the oneshot compact', async () => {
    const ctx = makeCtx({
      compactSession: async () => 'Nothing to compact (session too small)',
      sessionId: 's1',
    });

    await compactHandlers['/compact']!('', ctx);

    expect(sentBodies(ctx).join('\n')).toContain('❌');
  });

  it('tells the user when there is no resumable session', async () => {
    const compactSession = vi.fn();
    const ctx = makeCtx({ compactSession, sessionId: undefined });

    await compactHandlers['/compact']!('', ctx);

    expect(compactSession).not.toHaveBeenCalled();
    expect(sentBodies(ctx).join('\n')).toContain('没有可压缩的会话');
    expect(ctx.activeRuns.has('oc_1')).toBe(false);
  });

  it('sizes the timeout to the session and shows an ETA', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'omp-compact-size-'));
    // A fake session whose last assistant turn reports a 400k-token context.
    const lines = [
      JSON.stringify({ type: 'session', id: 'big-session', cwd: '/repo', timestamp: '2026-01-01T00:00:00.000Z' }),
      JSON.stringify({
        type: 'message',
        message: { role: 'assistant', content: [], usage: { input: 10, output: 5, cacheRead: 399985, cacheWrite: 0, totalTokens: 400000 } },
      }),
    ];
    await writeFile(join(dir, '2026-01-01T00-00-00-000Z_big-session.jsonl'), lines.join('\n') + '\n', 'utf8');

    const compactSession = vi.fn(async (_o: { timeoutMs?: number }) => undefined);
    const ctx = makeCtx({ compactSession, sessionId: 'big-session', sessionDir: dir });

    await compactHandlers['/compact']!('', ctx);

    // 399,995 tokens × 1.35 s/k × safety 3 = 1,620 s ≈ 27 min, above the floor.
    const call = compactSession.mock.calls[0]![0];
    expect(call.timeoutMs).toBe(1_620_000);
  });

  it('falls back to the default timeout for unknown sessions', async () => {
    const compactSession = vi.fn(async (_o: { timeoutMs?: number }) => undefined);
    const ctx = makeCtx({ compactSession, sessionId: 'ghost', sessionDir: '/nonexistent-omp-bridge-test' });

    await compactHandlers['/compact']!('', ctx);

    expect(compactSession.mock.calls[0]![0].timeoutMs).toBe(600_000);
    expect(sentBodies(ctx).join('\n')).toContain('正在压缩');
  });
  it('occupies the run slot for the duration of oneshot compact', async () => {
    const resolvers: Array<(v: string | undefined) => void> = [];
    const compactSession = vi.fn(
      () => new Promise<string | undefined>((r) => { resolvers.push(r); }),
    );
    const activeRuns = new ActiveRuns();
    const ctx = makeCtx({ activeRuns, compactSession, sessionId: 's1' });

    const first = compactHandlers['/compact']!('', ctx);
    await vi.waitFor(() => expect(activeRuns.has('oc_1')).toBe(true));
    await vi.waitFor(() => expect(compactSession).toHaveBeenCalledTimes(1));

    await compactHandlers['/compact']!('keep the last question', ctx);
    expect(sentBodies(ctx).join('\n')).toContain('任务结束后');
    expect(compactSession).toHaveBeenCalledTimes(1);

    resolvers.shift()!(undefined);
    await first;
    await vi.waitFor(() => expect(compactSession).toHaveBeenCalledTimes(2));
    resolvers.shift()!(undefined);
    await vi.waitFor(() => expect(activeRuns.has('oc_1')).toBe(false));
  });

  it('aborts an in-flight compact on /stop', async () => {
    const compactSession = vi.fn(async (opts: { signal?: AbortSignal }) => {
      if (opts.signal?.aborted) return '压缩已取消';
      return new Promise<string | undefined>((resolve) => {
        opts.signal?.addEventListener('abort', () => resolve('压缩已取消'));
      });
    });
    const activeRuns = new ActiveRuns();
    const ctx = makeCtx({ activeRuns, compactSession, sessionId: 's1' });

    const pending = compactHandlers['/compact']!('', ctx);
    await vi.waitFor(() => expect(activeRuns.has('oc_1')).toBe(true));
    expect(activeRuns.interrupt('oc_1')).toBe(true);
    await pending;

    expect(sentBodies(ctx).join('\n')).toContain('压缩已取消');
    expect(activeRuns.has('oc_1')).toBe(false);
  });

  it('does not warn about a missing session when a deferred compact no-ops after /new', async () => {
    const activeRuns = new ActiveRuns();
    const compactSession = vi.fn(async () => undefined);
    let sessionId: string | undefined = 's1';
    const ctx = makeCtx({ activeRuns, compactSession, sessionId: 's1' });
    ctx.sessions = { resumeFor: () => sessionId } as unknown as CommandContext['sessions'];
    const run = { events: (async function* () {})(), stop: async () => {}, waitForExit: async () => true };
    activeRuns.register('oc_1', run);

    await compactHandlers['/compact']!('', ctx);
    expect(compactSession).not.toHaveBeenCalled();

    sessionId = undefined;
    activeRuns.unregister('oc_1', run);
    await vi.waitFor(() => expect(activeRuns.has('oc_1')).toBe(false));

    expect(compactSession).not.toHaveBeenCalled();
    expect(sentBodies(ctx).join('\n')).not.toContain('没有可压缩的会话');
  });

  it('reports when the adapter cannot compact', async () => {
    const ctx = makeCtx({ sessionId: 's1' });
    ctx.agent = {} as CommandContext['agent'];
    await compactHandlers['/compact']!('', ctx);
    expect(sentBodies(ctx).join('\n')).toContain('不支持压缩会话');
    expect(ctx.activeRuns.has('oc_1')).toBe(false);
  });
  it('queues onto a run that lands between idle check and occupy', async () => {
    const activeRuns = new ActiveRuns();
    const compactSession = vi.fn(async () => undefined);
    const ctx = makeCtx({ activeRuns, compactSession, sessionId: 's1' });
    const steal = { events: (async function* () {})(), stop: async () => {}, waitForExit: async () => true };
    const origHas = activeRuns.has.bind(activeRuns);
    let n = 0;
    const spy = vi.spyOn(activeRuns, 'has').mockImplementation((id: string) => {
      n += 1;
      if (n === 3) activeRuns.register('oc_1', steal);
      return origHas(id);
    });

    await compactHandlers['/compact']!('keep it', ctx);
    expect(compactSession).not.toHaveBeenCalled();
    spy.mockRestore();

    activeRuns.unregister('oc_1', steal);
    await vi.waitFor(() => expect(compactSession).toHaveBeenCalledTimes(1));
    expect(compactSession).toHaveBeenCalledWith(expect.objectContaining({ customInstructions: 'keep it' }));
  });

  it('releases the slot when compactSession throws', async () => {
    const activeRuns = new ActiveRuns();
    const ctx = makeCtx({
      activeRuns,
      compactSession: async () => { throw new Error('boom'); },
      sessionId: 's1',
    });
    await expect(compactHandlers['/compact']!('', ctx)).rejects.toThrow('boom');
    expect(activeRuns.has('oc_1')).toBe(false);
  });

  it('reports a thrown compactSession as failure when deferred', async () => {
    const activeRuns = new ActiveRuns();
    const compactSession = vi.fn(async () => { throw new Error('boom'); });
    const ctx = makeCtx({ activeRuns, compactSession, sessionId: 's1' });
    const run = { events: (async function* () {})(), stop: async () => {}, waitForExit: async () => true };
    activeRuns.register('oc_1', run);

    await compactHandlers['/compact']!('', ctx);
    activeRuns.unregister('oc_1', run);
    await vi.waitFor(() => expect(sentBodies(ctx).join('\n')).toContain('压缩失败'));
    expect(activeRuns.has('oc_1')).toBe(false);
  });

  it('aborts an in-flight compact on stopAll', async () => {
    const compactSession = vi.fn(async (opts: { signal?: AbortSignal }) => {
      if (opts.signal?.aborted) return '压缩已取消';
      return new Promise<string | undefined>((resolve) => {
        opts.signal?.addEventListener('abort', () => resolve('压缩已取消'));
      });
    });
    const activeRuns = new ActiveRuns();
    const ctx = makeCtx({ activeRuns, compactSession, sessionId: 's1' });

    const pending = compactHandlers['/compact']!('', ctx);
    await vi.waitFor(() => expect(activeRuns.has('oc_1')).toBe(true));
    await activeRuns.stopAll();
    await pending;
    expect(sentBodies(ctx).join('\n')).toContain('压缩已取消');
    expect(activeRuns.has('oc_1')).toBe(false);
  });
});

describe('ActiveRuns deferred compact', () => {
  it('fires the deferred callback on unregister', () => {
    const activeRuns = new ActiveRuns();
    const run = { events: (async function* () {})(), stop: async () => {}, waitForExit: async () => true };
    activeRuns.register('scope-1', run);
    let fired = 0;
    expect(activeRuns.deferCompact('scope-1', () => { fired += 1; })).toBe(true);
    activeRuns.unregister('scope-1', run);
    expect(fired).toBe(1);
  });

  it('replaces an earlier deferred compact with the latest', () => {
    const activeRuns = new ActiveRuns();
    const run = { events: (async function* () {})(), stop: async () => {}, waitForExit: async () => true };
    activeRuns.register('scope-1', run);
    const seen: string[] = [];
    activeRuns.deferCompact('scope-1', () => { seen.push('first'); });
    activeRuns.deferCompact('scope-1', () => { seen.push('second'); });
    activeRuns.unregister('scope-1', run);
    expect(seen).toEqual(['second']);
  });

  it('fires the deferred callback on unregister after interrupt', () => {
    const activeRuns = new ActiveRuns();
    const run = { events: (async function* () {})(), stop: async () => {}, waitForExit: async () => true };
    activeRuns.register('scope-1', run);
    let fired = 0;
    activeRuns.deferCompact('scope-1', () => { fired += 1; });
    expect(activeRuns.interrupt('scope-1')).toBe(true);
    expect(activeRuns.has('scope-1')).toBe(true);
    expect(fired).toBe(0);
    activeRuns.unregister('scope-1', run);
    expect(fired).toBe(1);
    expect(activeRuns.has('scope-1')).toBe(false);
  });
  it('returns false when no run is active', () => {
    expect(new ActiveRuns().deferCompact('scope-1', () => {})).toBe(false);
  });
});

describe('OmpAdapter.compactSession', () => {
  it('sends compact after ready and resolves undefined on success', async () => {
    const binary = await fakeOmp(`
let buf = '';
process.stdin.on('data', (d) => {
  buf += d;
  const frame = JSON.parse(buf.toString().trim());
  if (frame.type === 'compact') {
    process.stdout.write(JSON.stringify({ id: frame.id, type: 'response', command: 'compact', success: true }) + '\\n');
    setTimeout(() => process.exit(0), 20);
  }
});
process.stdout.write(JSON.stringify({ type: 'ready', protocolVersion: 1 }) + '\\n');
`);
    const adapter = new OmpAdapter({ binary });
    await expect(adapter.compactSession({ sessionId: 's1', cwd: tmpdir() })).resolves.toBeUndefined();
  });

  it('resolves with the server error string on failure', async () => {
    const binary = await fakeOmp(`
let buf = '';
process.stdin.on('data', (d) => {
  buf += d;
  const frame = JSON.parse(buf.toString().trim());
  if (frame.type === 'compact') {
    process.stdout.write(JSON.stringify({ id: frame.id, type: 'response', command: 'compact', success: false, error: 'Nothing to compact (session too small)' }) + '\\n');
    setTimeout(() => process.exit(0), 20);
  }
});
process.stdout.write(JSON.stringify({ type: 'ready', protocolVersion: 1 }) + '\\n');
`);
    const adapter = new OmpAdapter({ binary });
    await expect(
      adapter.compactSession({ sessionId: 's1', cwd: tmpdir() }),
    ).resolves.toBe('Nothing to compact (session too small)');
  });

  it('passes customInstructions through to the frame', async () => {
    const binary = await fakeOmp(`
let buf = '';
process.stdin.on('data', (d) => {
  buf += d;
  const frame = JSON.parse(buf.toString().trim());
  if (frame.type === 'compact') {
    if (frame.customInstructions !== 'keep it short') process.exit(3);
    process.stdout.write(JSON.stringify({ id: frame.id, type: 'response', command: 'compact', success: true }) + '\\n');
    setTimeout(() => process.exit(0), 20);
  }
});
process.stdout.write(JSON.stringify({ type: 'ready', protocolVersion: 1 }) + '\\n');
`);
    const adapter = new OmpAdapter({ binary });
    await expect(
      adapter.compactSession({ sessionId: 's1', cwd: tmpdir(), customInstructions: 'keep it short' }),
    ).resolves.toBeUndefined();
  });

  it('reports spawn failure for a missing binary', async () => {
    const adapter = new OmpAdapter({ binary: '/nonexistent/omp-binary' });
    const error = await adapter.compactSession({ sessionId: 's1', cwd: tmpdir() });
    expect(error).toMatch(/omp 启动失败/);
  });

  // Integration exception to the no-timers rule: this exercises the adapter's
  // real timeout against a real child process — fake timers can't drive stdin
  // I/O. 50 ms keeps the wall-clock cost negligible.
  it('kills the child and reports a timeout when compact never answers', async () => {
    // Ready but never responds to the compact frame — the incident shape.
    const binary = await fakeOmp(`
process.stdout.write(JSON.stringify({ type: 'ready', protocolVersion: 1 }) + '\\n');
setInterval(() => {}, 1000);
`);
    const adapter = new OmpAdapter({ binary });
    await expect(
      adapter.compactSession({ sessionId: 's1', cwd: tmpdir(), timeoutMs: 50 }),
    ).resolves.toMatch(/omp 压缩超时/);
  });
  it('lets the child finish flushing after success instead of SIGTERM', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'omp-compact-flush-'));
    const marker = join(dir, 'flushed');
    const binary = await fakeOmp(`
import { writeFileSync } from 'node:fs';
process.on('SIGTERM', () => process.exit(99));
let buf = '';
process.stdin.on('data', (d) => {
  buf += d;
  const frame = JSON.parse(buf.toString().trim());
  if (frame.type === 'compact') {
    process.stdout.write(JSON.stringify({ id: frame.id, type: 'response', command: 'compact', success: true }) + '\\n');
    setTimeout(() => {
      writeFileSync(${JSON.stringify(marker)}, 'ok');
      process.exit(0);
    }, 40);
  }
});
process.stdout.write(JSON.stringify({ type: 'ready', protocolVersion: 1 }) + '\\n');
`);
    const adapter = new OmpAdapter({ binary });
    await expect(adapter.compactSession({ sessionId: 's1', cwd: tmpdir() })).resolves.toBeUndefined();
    const { readFile } = await import('node:fs/promises');
    await expect(readFile(marker, 'utf8')).resolves.toBe('ok');
  });

  it('kills the child when the abort signal fires', async () => {
    const binary = await fakeOmp(`
process.stdout.write(JSON.stringify({ type: 'ready', protocolVersion: 1 }) + '\\n');
setInterval(() => {}, 1000);
`);
    const adapter = new OmpAdapter({ binary });
    const abort = new AbortController();
    const pending = adapter.compactSession({ sessionId: 's1', cwd: tmpdir(), timeoutMs: 5_000, signal: abort.signal });
    await new Promise((r) => setTimeout(r, 80));
    abort.abort();
    await expect(pending).resolves.toBe('压缩已取消');
  });

  it('returns cancelled without spawning when the signal is already aborted', async () => {
    const adapter = new OmpAdapter({ binary: '/nonexistent/omp-binary' });
    const abort = new AbortController();
    abort.abort();
    await expect(
      adapter.compactSession({ sessionId: 's1', cwd: tmpdir(), signal: abort.signal }),
    ).resolves.toBe('压缩已取消');
  });
  it('reports an early child exit before compact answers', async () => {
    const binary = await fakeOmp(`
setTimeout(() => process.exit(2), 30);
`);
    const adapter = new OmpAdapter({ binary });
    await expect(adapter.compactSession({ sessionId: 's1', cwd: tmpdir() })).resolves.toMatch(/omp 提前退出/);
  });

  it('includes stderr on a compact failure', async () => {
    const binary = await fakeOmp(`
process.stderr.write('boom-detail');
let buf = '';
process.stdin.on('data', (d) => {
  buf += d;
  const frame = JSON.parse(buf.toString().trim());
  if (frame.type === 'compact') {
    process.stdout.write(JSON.stringify({ id: frame.id, type: 'response', command: 'compact', success: false, error: 'nope' }) + '\\n');
    setTimeout(() => process.exit(0), 20);
  }
});
process.stdout.write(JSON.stringify({ type: 'ready', protocolVersion: 1 }) + '\\n');
`);
    const adapter = new OmpAdapter({ binary });
    await expect(adapter.compactSession({ sessionId: 's1', cwd: tmpdir() })).resolves.toMatch(/nope.*boom-detail/s);
  });

  it('SIGKILLs a child that ignores SIGTERM after success', async () => {
    const binary = await fakeOmp(`
process.on('SIGTERM', () => {});
process.stdout.write(JSON.stringify({ type: 'ready', protocolVersion: 1 }) + '\\n');
let buf = '';
process.stdin.on('data', (d) => {
  buf += d;
  const frame = JSON.parse(buf.toString().trim());
  if (frame.type === 'compact') {
    process.stdout.write(JSON.stringify({ id: frame.id, type: 'response', command: 'compact', success: true }) + '\\n');
  }
});
setInterval(() => {}, 1000);
`);
    const adapter = new OmpAdapter({ binary });
    await expect(
      adapter.compactSession({ sessionId: 's1', cwd: tmpdir(), timeoutMs: 2_000 }),
    ).resolves.toBeUndefined();
  }, 15_000);
});
