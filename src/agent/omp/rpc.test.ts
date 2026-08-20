import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  isExtensionUiRequest,
  loadOmpImages,
  parseOmpJsonLine,
  translateOmpFrame,
} from './rpc';

function events(raw: unknown) {
  return [...translateOmpFrame(raw)];
}

describe('parseOmpJsonLine', () => {
  it('parses valid JSON lines', () => {
    expect(parseOmpJsonLine('{"type":"ready"}')).toEqual({ type: 'ready' });
  });

  it('returns undefined for non-JSON lines', () => {
    expect(parseOmpJsonLine('human-readable startup noise')).toBeUndefined();
  });
});

describe('translateOmpFrame', () => {
  it('maps get_state responses to system events', () => {
    expect(events({
      id: 'state_1',
      type: 'response',
      command: 'get_state',
      success: true,
      data: { sessionId: 'session-1', model: { provider: 'openai', id: 'gpt-5.5' } },
    })).toEqual([
      { type: 'system', sessionId: 'session-1', model: 'openai/gpt-5.5' },
    ]);
  });

  it('maps text and thinking deltas', () => {
    expect(events({
      type: 'message_update',
      assistantMessageEvent: { type: 'text_delta', delta: 'hello' },
    })).toEqual([{ type: 'text', delta: 'hello' }]);

    expect(events({
      type: 'message_update',
      assistantMessageEvent: { type: 'thinking_delta', delta: 'hmm' },
    })).toEqual([{ type: 'thinking', delta: 'hmm' }]);
  });

  it('maps tool execution start and completion to tool events', () => {
    expect(events({
      type: 'tool_execution_start',
      toolCallId: 'tool-1',
      toolName: 'bash',
      args: { command: 'pwd' },
    })).toEqual([
      { type: 'tool_use', id: 'tool-1', name: 'bash', input: { command: 'pwd' } },
    ]);

    expect(events({
      type: 'tool_execution_end',
      toolCallId: 'tool-1',
      toolName: 'bash',
      result: { content: [{ type: 'text', text: '/tmp\n' }] },
      isError: false,
    })).toEqual([
      { type: 'tool_result', id: 'tool-1', output: '/tmp\n', isError: false },
    ]);

    expect(events({
      type: 'tool_execution_update',
      toolCallId: 'tool-1',
      toolName: 'bash',
      partialResult: { content: [{ type: 'text', text: 'working' }] },
    })).toEqual([
      { type: 'tool_update', id: 'tool-1', output: 'working' },
    ]);
  });

  it('maps usage and terminal frames', () => {
    expect(events({
      type: 'turn_end',
      message: { usage: { input: 10, output: 5, cost: { total: 0.01 } } },
    })).toEqual([
      { type: 'usage', inputTokens: 10, outputTokens: 5, costUsd: 0.01 },
    ]);

    expect(events({ type: 'agent_end' })).toEqual([{ type: 'done' }]);
  });

  it('maps failed command responses to errors', () => {
    expect(events({ type: 'response', command: 'prompt', success: false, error: 'bad' })).toEqual([
      { type: 'error', message: 'bad' },
    ]);
  });

  it('maps subagent lifecycle frames', () => {
    expect(events({
      type: 'subagent_lifecycle',
      payload: { id: 'sa-1', agent: 'reviewer', description: 'review auth', status: 'started' },
    })).toEqual([
      { type: 'subagent_lifecycle', id: 'sa-1', agent: 'reviewer', description: 'review auth', status: 'started' },
    ]);

    expect(events({
      type: 'subagent_lifecycle',
      payload: { id: 'sa-1', agent: 'reviewer', status: 'failed' },
    })).toEqual([
      { type: 'subagent_lifecycle', id: 'sa-1', agent: 'reviewer', description: undefined, status: 'failed' },
    ]);
  });
});

describe('extension UI frames', () => {
  it('maps blocking UI requests instead of auto-cancelling them', () => {
    expect(isExtensionUiRequest({ type: 'extension_ui_request', id: 'ui-1', method: 'confirm' })).toBe(true);
    expect(events({
      type: 'extension_ui_request',
      id: 'ui-1',
      method: 'confirm',
      title: 'Confirm',
      message: 'Continue?',
      timeout: 30000,
    })).toEqual([
      {
        type: 'ui_request',
        request: {
          id: 'ui-1',
          method: 'confirm',
          title: 'Confirm',
          message: 'Continue?',
          timeout: 30000,
        },
      },
    ]);
  });

  it('maps non-blocking UI updates to state events', () => {
    expect(events({
      type: 'extension_ui_request',
      id: 'status-1',
      method: 'setStatus',
      statusKey: 'ext',
      statusText: 'working',
    })).toEqual([{ type: 'ui_status', status: { key: 'ext', text: 'working' } }]);

    expect(events({
      type: 'extension_ui_request',
      id: 'widget-1',
      method: 'setWidget',
      widgetKey: 'todo',
      widgetLines: ['a', 'b'],
      widgetPlacement: 'belowEditor',
    })).toEqual([{ type: 'ui_widget', widget: { key: 'todo', lines: ['a', 'b'], placement: 'belowEditor' } }]);
  });

  it('surfaces the loopback launchUrl when present', () => {
    expect(events({
      type: 'extension_ui_request',
      id: 'url-1',
      method: 'open_url',
      url: 'https://login.example.com/oauth?token=verylong',
      launchUrl: 'http://127.0.0.1:39211/launch/abc',
      instructions: 'copy this to authorize',
    })).toEqual([
      {
        type: 'ui_open_url',
        url: 'https://login.example.com/oauth?token=verylong',
        instructions: 'copy this to authorize',
        launchUrl: 'http://127.0.0.1:39211/launch/abc',
      },
    ]);
  });
});

describe('loadOmpImages', () => {
  it('converts local images into OMP RPC image content', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'omp-rpc-image-'));
    const path = join(dir, 'a.png');
    await writeFile(path, Buffer.from([1, 2, 3]));

    await expect(loadOmpImages([path])).resolves.toEqual([
      { type: 'image', data: 'AQID', mimeType: 'image/png' },
    ]);
  });
});
