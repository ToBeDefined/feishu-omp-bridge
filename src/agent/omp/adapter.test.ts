import { chmod, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { OmpAdapter } from './adapter';
import type { AgentEvent } from '../types';

async function fakeOmp(source: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'omp-adapter-test-'));
  const path = join(dir, 'omp-fake.mjs');
  await writeFile(path, `#!/usr/bin/env node\n${source}`, 'utf8');
  await chmod(path, 0o700);
  return path;
}

async function collect(events: AsyncIterable<AgentEvent>): Promise<AgentEvent[]> {
  const out: AgentEvent[] = [];
  for await (const event of events) out.push(event);
  return out;
}

describe('OmpAdapter', () => {
  it('does not hang when the binary cannot be spawned', async () => {
    const run = new OmpAdapter({ binary: join(tmpdir(), 'omp-missing-binary-xyz') }).run({
      prompt: 'ping',
      cwd: tmpdir(),
    });
    // Node emits 'error' + 'close' (never 'exit') when exec itself fails, and
    // exitCode/signalCode stay null — waiting on 'exit' hung the caller (and
    // its chat's run slot) forever.
    const events = await collect(run.events);
    expect(events).toHaveLength(1);
    expect(events[0]?.type).toBe('error');
    expect(events[0]?.type === 'error' ? events[0].message : '').toContain('failed to spawn omp');
    await expect(run.waitForExit(500)).resolves.toBe(true);
    await expect(run.stop()).resolves.toBeUndefined();
  });

  it('reports availability from the configured binary', async () => {
    const binary = await fakeOmp(`
if (process.argv.includes('--version')) {
  console.log('omp v1.0.0');
  process.exit(0);
}
process.exit(1);
`);

    await expect(new OmpAdapter({ binary }).isAvailable()).resolves.toBe(true);
  });

  it('translates RPC stdout from an OMP run', async () => {
    const binary = await fakeOmp(`
import { createInterface } from 'node:readline';
if (process.argv.includes('--version')) process.exit(0);
console.log(JSON.stringify({ type: 'ready' }));
const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });
for await (const line of rl) {
  const frame = JSON.parse(line);
  if (frame.type === 'get_state') {
    console.log(JSON.stringify({ id: frame.id, type: 'response', command: 'get_state', success: true, data: { sessionId: 'session-1', model: { provider: 'test', id: 'model' } } }));
  }
  if (frame.type === 'prompt') {
    if (!frame.message.includes('ping')) process.exit(9);
    console.log(JSON.stringify({ id: frame.id, type: 'response', command: 'prompt', success: true }));
    console.log(JSON.stringify({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: 'pong' } }));
    console.log(JSON.stringify({ type: 'turn_end', message: { usage: { input: 1, output: 2 } } }));
    console.log(JSON.stringify({ type: 'agent_end' }));
  }
}
`);

    const run = new OmpAdapter({ binary, sessionDir: '/sessions' }).run({ prompt: 'ping', cwd: tmpdir() });

    await expect(collect(run.events)).resolves.toEqual([
      { type: 'system', sessionId: 'session-1', model: 'test/model' },
      { type: 'text', delta: 'pong' },
      { type: 'usage', inputTokens: 1, outputTokens: 2, costUsd: undefined },
      { type: 'done' },
    ]);
    await expect(run.waitForExit(100)).resolves.toBe(true);
  });

  it('keeps blocking extension UI requests interactive and accepts responses', async () => {
    const binary = await fakeOmp(`
import { createInterface } from 'node:readline';
console.log(JSON.stringify({ type: 'ready' }));
const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });
for await (const line of rl) {
  const frame = JSON.parse(line);
  if (frame.type === 'prompt') {
    console.log(JSON.stringify({ id: frame.id, type: 'response', command: 'prompt', success: true }));
    console.log(JSON.stringify({ type: 'extension_ui_request', id: 'ui-1', method: 'confirm', title: 'Confirm', message: 'Continue?' }));
  }
  if (frame.type === 'extension_ui_response' && frame.id === 'ui-1' && frame.confirmed === true) {
    console.log(JSON.stringify({ type: 'agent_end' }));
  }
}
`);

    const run = new OmpAdapter({ binary }).run({ prompt: 'ping', cwd: tmpdir() });
    const iterator = run.events[Symbol.asyncIterator]();

    await expect(iterator.next()).resolves.toEqual({
      done: false,
      value: {
        type: 'ui_request',
        request: { id: 'ui-1', method: 'confirm', title: 'Confirm', message: 'Continue?' },
      },
    });
    expect(run.respondToUi?.('ui-1', { confirmed: true })).toBe(true);
    await expect(iterator.next()).resolves.toEqual({ done: false, value: { type: 'done' } });
  });

  it('registers and serves OMP host tools and URI schemes', async () => {
    const binary = await fakeOmp(`
import { createInterface } from 'node:readline';
console.log(JSON.stringify({ type: 'ready' }));
const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });
let sawTools = false;
let sawSchemes = false;
for await (const line of rl) {
  const frame = JSON.parse(line);
  if (frame.type === 'set_host_tools' && frame.tools?.[0]?.name === 'bridge_echo') sawTools = true;
  if (frame.type === 'set_host_uri_schemes' && frame.schemes?.[0]?.scheme === 'bridge') sawSchemes = true;
  if (frame.type === 'prompt') {
    if (!sawTools || !sawSchemes) process.exit(8);
    console.log(JSON.stringify({ type: 'host_tool_call', id: 'host-1', toolCallId: 'tool-1', toolName: 'bridge_echo', arguments: { message: 'hi' } }));
  }
  if (frame.type === 'host_tool_result' && frame.id === 'host-1') {
    console.log(JSON.stringify({ type: 'host_uri_request', id: 'uri-1', operation: 'read', url: 'bridge://context' }));
  }
  if (frame.type === 'host_uri_result' && frame.id === 'uri-1') {
    console.log(JSON.stringify({ type: 'agent_end' }));
  }
}
`);

    const run = new OmpAdapter({ binary }).run({
      prompt: 'ping',
      cwd: tmpdir(),
      hostTools: [{
        definition: { name: 'bridge_echo', description: 'Echo a message', parameters: { type: 'object' } },
        async execute(args) {
          return { result: `echo:${String(args.message)}` };
        },
      }],
      hostUriSchemes: [{
        definition: { scheme: 'bridge', description: 'Bridge test scheme' },
        async handle(req) {
          return { content: `uri:${req.url}`, contentType: 'text/plain' };
        },
      }],
    });

    await expect(collect(run.events)).resolves.toEqual([
      { type: 'tool_use', id: 'tool-1', name: 'bridge_echo', input: { message: 'hi' } },
      { type: 'tool_result', id: 'tool-1', output: 'echo:hi', isError: false },
      { type: 'tool_use', id: 'uri-1', name: 'host_uri_read', input: { url: 'bridge://context' } },
      { type: 'tool_result', id: 'uri-1', output: 'uri:bridge://context', isError: false },
      { type: 'done' },
    ]);
  });

  it('surfaces non-zero OMP exits after stdout closes', async () => {
    const binary = await fakeOmp(`
console.error('auth required');
process.exit(7);
`);

    const run = new OmpAdapter({ binary }).run({ prompt: 'ping', cwd: tmpdir() });

    await expect(collect(run.events)).resolves.toEqual([
      { type: 'error', message: 'omp exited with code 7: auth required' },
    ]);
  });

  it('terminates the stream when the child exits before the consumer starts reading', async () => {
    const binary = await fakeOmp(`
console.error('Error: Session "01a0b305-7eae-71a5-9574-ac4e0845f6fb" not found.');
process.exit(1);
`);

    const run = new OmpAdapter({ binary }).run({
      prompt: 'ping',
      cwd: tmpdir(),
      sessionId: '01a0b305-7eae-71a5-9574-ac4e0845f6fb',
    });

    // The bridge spends seconds on media + the initial card send before it
    // reads a single frame; a child that is already gone by then must still
    // produce a terminal event instead of leaving the run hanging forever.
    await expect(run.waitForExit(5_000)).resolves.toBe(true);

    await expect(collect(run.events)).resolves.toEqual([
      { type: 'error', message: expect.stringContaining('omp exited with code 1: Error: Session') },
    ]);
    expect(run.staleSession).toBe(true);
  });

  it('keeps the session id when OMP failed after a successful resume', async () => {
    const binary = await fakeOmp(`
console.log(JSON.stringify({ type: 'ready' }));
console.error('Error: model "x" not found');
process.exit(1);
`);

    const run = new OmpAdapter({ binary }).run({
      prompt: 'ping',
      cwd: tmpdir(),
      sessionId: 'session-1',
    });

    await expect(collect(run.events)).resolves.toEqual([
      { type: 'error', message: expect.stringContaining('omp exited with code 1') },
    ]);
    expect(run.staleSession).toBe(false);
  });
});
