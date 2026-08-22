import { describe, expect, it } from 'vitest';
import { AGENT_CALLBACK_MARKER, buildAgentCard } from './agent-card';

type Button = { text: { content: string }; type: string; behaviors: Array<{ type: string; value: unknown }> };
type Card = {
  schema: string;
  config: { summary: { content: string } };
  body: { elements: Array<Record<string, unknown>> };
};

function buttonsOf(card: Card): Button[] {
  const set = card.body.elements[1] as { columns: Array<{ elements: Array<Record<string, unknown>> }> };
  return set.columns.map((c) => c.elements[0] as unknown as Button);
}

describe('buildAgentCard', () => {
  it('builds a CardKit 2.0 card with markdown body and callback buttons in columns', () => {
    const card = buildAgentCard('确认发布', '要发布到生产吗？', [
      { label: '发布', value: { action: 'deploy', env: 'prod' } },
      { label: '取消', value: { action: 'cancel' } },
    ]) as unknown as Card;

    expect(card.schema).toBe('2.0');
    expect(card.config.summary.content).toBe('确认发布');

    const elements = card.body.elements;
    expect(elements[0]).toEqual({ tag: 'markdown', content: '要发布到生产吗？' });
    expect(elements[1]).toMatchObject({ tag: 'column_set', flex_mode: 'flow' });

    const buttons = buttonsOf(card);
    expect(buttons).toHaveLength(2);
    expect(buttons[0]?.text.content).toBe('发布');
    expect(buttons[0]?.type).toBe('primary');
    expect(buttons[0]?.behaviors[0]?.type).toBe('callback');
    expect(buttons[0]?.behaviors[0]?.value).toEqual({ action: 'deploy', env: 'prod', [AGENT_CALLBACK_MARKER]: true });

    expect(buttons[1]?.text.content).toBe('取消');
    expect(buttons[1]?.type).toBe('default');
    expect(buttons[1]?.behaviors[0]?.value).toEqual({ action: 'cancel', [AGENT_CALLBACK_MARKER]: true });
  });

  it('never emits the unsupported `action` tag (schema 2.0 rejects it)', () => {
    const json = JSON.stringify(buildAgentCard('t', 'text', [{ label: 'go', value: { a: 1 } }]));
    expect(json).not.toContain('"action"');
  });

  it('injects the marker without mutating the original button value', () => {
    const value = { action: 'deploy' };
    const card = buildAgentCard('t', 'text', [{ label: 'go', value }]) as unknown as Card;
    expect(buttonsOf(card)[0]?.behaviors[0]?.value).toEqual({ action: 'deploy', [AGENT_CALLBACK_MARKER]: true });
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
