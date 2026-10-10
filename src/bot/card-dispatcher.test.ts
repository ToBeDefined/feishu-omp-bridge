import { describe, expect, it } from 'vitest';
import { handleCardAction, resolveCardCommand } from './card-dispatcher';
import { agentSelectedCard } from '../card/templates';

describe('agentSelectedCard', () => {
  it('renders a schema-2.0 card showing the frozen choice, without buttons', () => {
    const card = agentSelectedCard('发布') as {
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
    const card = agentSelectedCard('a*b_c') as { body: { elements: Array<{ content: string }> } };
    expect(card.body.elements[0]?.content).not.toContain('a*b');
  });
});

describe('resolveCardCommand', () => {
  it('maps the /history merge & split buttons to their text subcommands', () => {
    const merge = resolveCardCommand('work.merge', { arg: 'keep-id fold-id' });
    expect(merge).toEqual({ name: 'work', args: 'merge keep-id fold-id' });
    expect(`/${merge.name} ${merge.args}`).toBe('/work merge keep-id fold-id');

    const split = resolveCardCommand('work.split', { arg: 'ws-id 2' });
    expect(split).toEqual({ name: 'work', args: 'split ws-id 2' });
    expect(`/${split.name} ${split.args}`).toBe('/work split ws-id 2');
  });

  it('leaves the existing history buttons mapping unchanged', () => {
    expect(resolveCardCommand('history.resume', { arg: 'sid' })).toEqual({
      name: 'history',
      args: 'resume sid',
    });
    expect(resolveCardCommand('history.page', { arg: 'all 8' })).toEqual({
      name: 'history',
      args: 'page all 8',
    });
  });
});
