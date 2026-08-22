import { describe, expect, it } from 'vitest';
import { renderAgentSelectedCard } from './dispatcher';

describe('renderAgentSelectedCard', () => {
  it('renders a schema-2.0 card showing the frozen choice, without buttons', () => {
    const card = renderAgentSelectedCard('发布') as {
      schema: string;
      body: { elements: Array<{ tag: string; content: string }> };
    };
    expect(card.schema).toBe('2.0');
    expect(card.body.elements).toHaveLength(1);
    expect(card.body.elements[0]?.tag).toBe('markdown');
    expect(card.body.elements[0]?.content).toContain('已选择');
    expect(card.body.elements[0]?.content).toContain('发布');
    expect(JSON.stringify(card)).not.toContain('"button"');
  });

  it('escapes markdown metacharacters in the label', () => {
    const card = renderAgentSelectedCard('a*b_c') as { body: { elements: Array<{ content: string }> } };
    expect(card.body.elements[0]?.content).not.toContain('a*b');
  });
});
