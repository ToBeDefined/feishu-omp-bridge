import { describe, expect, it } from 'vitest';
import {
  AGENT_CALLBACK_MARKER,
  AGENT_MARK_ISSUED_AT,
  AGENT_MARK_RUN,
  AGENT_MARK_SCOPE,
  buildAgentCard,
} from './agent-card';

type Button = { name: string; text: { content: string }; type: string; behaviors: Array<{ type: string; value: unknown }> };
type Card = {
  schema: string;
  config: { summary: { content: string } };
  body: { elements: Array<Record<string, unknown>> };
};

function buttonsOf(card: Card): Button[] {
  const out: Button[] = [];
  for (const el of card.body.elements) {
    if (el.tag !== 'column_set') continue;
    const set = el as { columns: Array<{ elements: Array<Record<string, unknown>> }> };
    for (const c of set.columns) out.push(c.elements[0] as unknown as Button);
  }
  return out;
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
    // Heading first (S1), then the body, then the button rows.
    expect(elements[0]).toMatchObject({
      tag: 'markdown',
      content: '🤖 **确认发布**',
      text_size: 'heading',
    });
    expect(elements[1]).toEqual({ tag: 'markdown', content: '要发布到生产吗？' });
    expect(elements[2]).toMatchObject({ tag: 'column_set', flex_mode: 'none' });

    const buttons = buttonsOf(card);
    expect(buttons).toHaveLength(2);
    // At most 2 buttons per row: they share one `weighted` row (never `auto`).
    expect(JSON.stringify(elements[2])).toContain('"width":"weighted"');
    expect(JSON.stringify(elements[2])).not.toContain('"width":"auto"');
    expect(buttons[0]?.name).toBe('发布');
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

  it('stamps the bridge issuance marks when the caller supplies them', () => {
    const card = buildAgentCard(
      't',
      'text',
      [{ label: 'go', value: { action: 'deploy' } }],
      { issuedAt: 1234, scope: 'oc_1', run: 'run-1' },
    ) as unknown as Card;
    expect(buttonsOf(card)[0]?.behaviors[0]?.value).toEqual({
      action: 'deploy',
      [AGENT_MARK_ISSUED_AT]: 1234,
      [AGENT_MARK_SCOPE]: 'oc_1',
      [AGENT_MARK_RUN]: 'run-1',
      [AGENT_CALLBACK_MARKER]: true,
    });
  });

  it('omits the run mark when no run token is available', () => {
    const card = buildAgentCard(
      't',
      'text',
      [{ label: 'go', value: {} }],
      { issuedAt: 1, scope: 'oc_1' },
    ) as unknown as Card;
    const value = buttonsOf(card)[0]?.behaviors[0]?.value as Record<string, unknown>;
    expect(value[AGENT_MARK_SCOPE]).toBe('oc_1');
    expect(AGENT_MARK_RUN in value).toBe(false);
  });

  it('rejects model-supplied bridge marks (they are bridge-internal)', () => {
    expect(() =>
      buildAgentCard('t', 'text', [{ label: 'go', value: { [AGENT_MARK_RUN]: 'forged' } }]),
    ).toThrow('保留字段');
  });

  it('requires at least one button', () => {
    expect(() => buildAgentCard('t', 'text', [])).toThrow('at least one button');
  });

  it('rejects buttons missing label or object value', () => {
    expect(() => buildAgentCard('t', 'text', [{ value: { a: 1 } }])).toThrow('label (string) and value (object)');
    expect(() => buildAgentCard('t', 'text', [{ label: 'x', value: 'not-object' }])).toThrow('label (string) and value (object)');
  });

  it('rejects more than 10 buttons', () => {
    const buttons = Array.from({ length: 11 }, (_, i) => ({ label: `b${i}`, value: { i } }));
    expect(() => buildAgentCard('t', 'text', buttons)).toThrow('最多 10 个按钮');
  });

  it('rejects text longer than 4000 chars', () => {
    expect(() => buildAgentCard('t', 'x'.repeat(4001), [{ label: 'go', value: {} }])).toThrow('正文过长');
  });

  it('accepts the boundary (10 buttons, 4000-char text)', () => {
    const buttons = Array.from({ length: 10 }, (_, i) => ({ label: `b${i}`, value: { i } }));
    const card = buildAgentCard('t', 'x'.repeat(4000), buttons) as unknown as Card;
    expect(buttonsOf(card)).toHaveLength(10);
    // 10 buttons wrap at most 2 per row → 5 column_set rows, every column
    // `weighted` (never `auto`), so the row stays stable at any card width.
    const json = JSON.stringify(card);
    expect(json.match(/"flex_mode":"none"/g) ?? []).toHaveLength(5);
    expect(json.match(/"width":"weighted"/g) ?? []).toHaveLength(10);
    expect(json).not.toContain('"width":"auto"');
    expect(json).not.toContain('"flex_mode":"flow"');
  });

  it('escapes a model-supplied title in the heading', () => {
    const card = buildAgentCard('*重要*', 'text', [{ label: 'go', value: {} }]) as unknown as Card;
    // Escaped so the title cannot break out of the bold heading; still the
    // heading line. (`escapeMd` covers `* _ ` \ [ ] ( ) !`, not `#`/`>`, which
    // are harmless mid-line.)
    expect(card.body.elements[0]).toMatchObject({
      tag: 'markdown',
      content: '🤖 **\\*重要\\***',
      text_size: 'heading',
    });
    // The unescaped title still feeds the notification summary.
    expect(card.config.summary.content).toBe('*重要*');
  });

  it('exports the callback marker shared with the dispatcher', () => {
    expect(AGENT_CALLBACK_MARKER).toBe('__codex_cb');
  });
});
