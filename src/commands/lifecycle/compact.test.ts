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
  compactSession?: (opts: { sessionId: string; cwd?: string; model?: string; customInstructions?: string }) => Promise<string | undefined>;
  cwd?: string;
  sessionId?: string;
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
    controls: { cfg: {} },
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
    expect(compactSession).toHaveBeenCalledWith({
      sessionId: 's1',
      cwd: '/repo',
      model: undefined,
      customInstructions: 'keep the last question',
    });
  });

  it('compacts the persisted session when idle', async () => {
    const compactSession = vi.fn(async () => undefined);
    const ctx = makeCtx({ compactSession, cwd: '/repo', sessionId: 's1' });

    await compactHandlers['/compact']!('keep the last question', ctx);

    expect(compactSession).toHaveBeenCalledWith({
      sessionId: 's1',
      cwd: '/repo',
      model: undefined,
      customInstructions: 'keep the last question',
    });
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

  it('drops deferred compact when interrupt removes the handle', () => {
    const activeRuns = new ActiveRuns();
    const run = { events: (async function* () {})(), stop: async () => {}, waitForExit: async () => true };
    activeRuns.register('scope-1', run);
    let fired = 0;
    activeRuns.deferCompact('scope-1', () => { fired += 1; });
    activeRuns.interrupt('scope-1');
    expect(fired).toBe(0);
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
});
