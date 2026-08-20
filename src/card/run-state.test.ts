import { describe, expect, it } from 'vitest';
import { TEXT_BLOCK_SPLIT, initialState, reduce } from './run-state';

describe('text chunking', () => {
  it('splits a long streaming body into multiple blocks instead of dropping content', () => {
    let state = initialState;
    const chunk = 'a'.repeat(TEXT_BLOCK_SPLIT);
    state = reduce(state, { type: 'text', delta: chunk });
    state = reduce(state, { type: 'text', delta: 'tail' });
    const texts = state.blocks.filter((b) => b.kind === 'text');
    expect(texts.length).toBe(2);
    expect(texts[0]).toMatchObject({ kind: 'text', content: chunk, streaming: false });
    expect(texts[1]).toMatchObject({ kind: 'text', content: 'tail', streaming: true });
  });
});

describe('run-state OMP UI integration', () => {
  it('pauses the footer while waiting for native UI input', () => {
    const state = reduce(initialState, {
      type: 'ui_request',
      request: { id: 'ui-1', method: 'input', title: 'Need input', placeholder: 'value' },
    });

    expect(state.footer).toBe('waiting_input');
    expect(state.blocks.at(-1)).toEqual({
      kind: 'text',
      content: '🧩 OMP 需要用户交互：**Need input**\n\n已发送交互卡片，请在那里完成操作。',
      streaming: false,
    });
  });

  it('tracks mutable status and widget updates', () => {
    const withStatus = reduce(initialState, {
      type: 'ui_status',
      status: { key: 'extension', text: 'working' },
    });
    const withWidget = reduce(withStatus, {
      type: 'ui_widget',
      widget: { key: 'todo', lines: ['a', 'b'], placement: 'belowEditor' },
    });
    const cleared = reduce(withWidget, {
      type: 'ui_status',
      status: { key: 'extension', text: undefined },
    });

    expect(withWidget.ui.statuses).toEqual({ extension: 'working' });
    expect(withWidget.ui.widgets.todo).toEqual({ key: 'todo', lines: ['a', 'b'], placement: 'belowEditor' });
    expect(cleared.ui.statuses).toEqual({});
  });

  it('appends partial tool updates before final result', () => {
    const started = reduce(initialState, {
      type: 'tool_use',
      id: 'tool-1',
      name: 'bash',
      input: { command: 'pwd' },
    });
    const updated = reduce(started, { type: 'tool_update', id: 'tool-1', output: 'working' });
    const done = reduce(updated, { type: 'tool_result', id: 'tool-1', output: 'done', isError: false });

    expect(updated.blocks[0]).toMatchObject({ kind: 'tool', tool: { output: 'working', status: 'running' } });
    expect(done.blocks[0]).toMatchObject({ kind: 'tool', tool: { output: 'done', status: 'done' } });
  });

  it('tracks subagent lifecycle entries and preserves description on status updates', () => {
    const started = reduce(initialState, {
      type: 'subagent_lifecycle',
      id: 'sa-1',
      agent: 'reviewer',
      description: 'review auth flow',
      status: 'started',
    });
    expect(started.subagents).toEqual([
      { id: 'sa-1', agent: 'reviewer', description: 'review auth flow', status: 'started' },
    ]);

    const failed = reduce(started, {
      type: 'subagent_lifecycle',
      id: 'sa-1',
      agent: 'reviewer',
      status: 'failed',
    });
    expect(failed.subagents).toEqual([
      { id: 'sa-1', agent: 'reviewer', description: 'review auth flow', status: 'failed' },
    ]);
  });

  it('surfaces the short launchUrl with the full URL as context', () => {
    const state = reduce(initialState, {
      type: 'ui_open_url',
      url: 'https://login.example.com/oauth?token=verylong',
      launchUrl: 'http://127.0.0.1:39211/launch/abc',
    });
    const block = state.blocks[0];
    expect(block).toMatchObject({ kind: 'text' });
    if (block?.kind === 'text') {
      expect(block.content).toContain('http://127.0.0.1:39211/launch/abc');
      expect(block.content).toContain('https://login.example.com/oauth?token=verylong');
    }
  });
});
