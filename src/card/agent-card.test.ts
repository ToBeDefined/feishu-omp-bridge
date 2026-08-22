import { describe, expect, it } from 'vitest';
import { AGENT_CALLBACK_MARKER, buildAgentCard } from './agent-card';

describe('buildAgentCard', () => {
  it('builds a CardKit 2.0 card with markdown body and callback buttons', () => {
    const card = buildAgentCard('确认发布', '要发布到生产吗？', [
      { label: '发布', value: { action: 'deploy', env: 'prod' } },
      { label: '取消', value: { action: 'cancel' } },
    ]) as {
      schema: string;
      config: { summary: { content: string } };
      body: { elements: Array<Record<string, unknown>> };
    };

    expect(card.schema).toBe('2.0');
    expect(card.config.summary.content).toBe('确认发布');

    const elements = card.body.elements;
    expect(elements[0]).toEqual({ tag: 'markdown', content: '要发布到生产吗？' });

    const actions = (elements[1] as { actions: Array<Record<string, unknown>> }).actions;
    expect(actions).toHaveLength(2);

    expect(actions[0]?.text).toEqual({ tag: 'plain_text', content: '发布' });
    expect(actions[0]?.type).toBe('primary');
    const behaviors0 = (actions[0] as { behaviors: Array<{ type: string; value: unknown }> }).behaviors;
    expect(behaviors0[0]?.type).toBe('callback');
    expect(behaviors0[0]?.value).toEqual({ action: 'deploy', env: 'prod', [AGENT_CALLBACK_MARKER]: true });

    expect(actions[1]?.text).toEqual({ tag: 'plain_text', content: '取消' });
    expect(actions[1]?.type).toBe('default');
    const behaviors1 = (actions[1] as { behaviors: Array<{ type: string; value: unknown }> }).behaviors;
    expect(behaviors1[0]?.value).toEqual({ action: 'cancel', [AGENT_CALLBACK_MARKER]: true });
  });

  it('injects the marker without mutating the original button value', () => {
    const value = { action: 'deploy' };
    const card = buildAgentCard('t', 'text', [{ label: 'go', value }]) as {
      body: { elements: Array<Record<string, unknown>> };
    };
    const actions = (card.body.elements[1] as { actions: Array<{ behaviors: Array<{ value: unknown }> }> }).actions;
    expect(actions[0]?.behaviors[0]?.value).toEqual({ action: 'deploy', [AGENT_CALLBACK_MARKER]: true });
    expect(value).toEqual({ action: 'deploy' });
  });

  it('requires at least one button', () => {
    expect(() => buildAgentCard('t', 'text', [])).toThrow('at least one button');
  });

  it('rejects buttons missing label or object value', () => {
    expect(() => buildAgentCard('t', 'text', [{ value: { a: 1 } }])).toThrow('label (string) and value (object)');
    expect(() => buildAgentCard('t', 'text', [{ label: 'x', value: 'not-object' }])).toThrow('label (string) and value (object)');
  });

  it('exports the callback marker shared with the dispatcher', () => {
    expect(AGENT_CALLBACK_MARKER).toBe('__codex_cb');
  });
});
