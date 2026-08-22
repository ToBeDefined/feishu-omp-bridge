// Card builder for agent-authored Feishu interactive cards.

/**
 * Marker key on a button's `value` object that flags the cardAction as a
 * callback that should be forwarded back to the agent instead of dispatched
 * to a built-in command handler. Must match the constant the dispatcher
 * checks in `card/dispatcher.ts`.
 */
export const AGENT_CALLBACK_MARKER = '__codex_cb';

export interface AgentCardButton {
  label: string;
  value: Record<string, unknown>;
}

/**
 * Build a CardKit 2.0 card from a high-level shape: a markdown body plus a
 * row of callback buttons. Every button's value gets the agent-callback
 * marker injected, so clicks land back in the agent's session via the
 * existing `forwardToAgent` path.
 */
export function buildAgentCard(title: string, text: string, buttons: unknown): object {
  if (!Array.isArray(buttons) || buttons.length === 0) {
    throw new Error('buttons is required (at least one button)');
  }
  const normalized = buttons.map((raw) => {
    const b = raw as Partial<AgentCardButton> | null;
    const label = typeof b?.label === 'string' && b.label.trim() ? b.label : '';
    const value = b?.value && typeof b.value === 'object' && !Array.isArray(b.value) ? b.value : undefined;
    if (!label || !value) {
      throw new Error('each button requires label (string) and value (object)');
    }
    return { label, value };
  });

  return {
    schema: '2.0',
    config: { summary: { content: title } },
    body: {
      elements: [
        { tag: 'markdown', content: text },
        {
          tag: 'action',
          actions: normalized.map(({ label, value }, i) => ({
            tag: 'button',
            text: { tag: 'plain_text', content: label },
            type: i === 0 ? 'primary' : 'default',
            behaviors: [{ type: 'callback', value: { ...value, [AGENT_CALLBACK_MARKER]: true } }],
          })),
        },
      ],
    },
  };
}
