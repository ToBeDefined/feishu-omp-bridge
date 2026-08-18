import { describe, expect, it } from 'vitest';
import { modelSelectCard } from './model-card';

const MODELS = [
  { provider: 'zhipu-coding-plan', selector: 'zhipu-coding-plan/glm-5.2', name: 'GLM-5.2' },
  { provider: 'zhipu-coding-plan', selector: 'zhipu-coding-plan/glm-5.3', name: 'GLM-5.3' },
];

interface SelectStatic {
  options?: unknown[];
  initial_option?: unknown;
}

function isSelectStatic(value: unknown): value is SelectStatic {
  return (
    typeof value === 'object' &&
    value !== null &&
    'tag' in value &&
    value.tag === 'select_static'
  );
}

function readElements(holder: object): unknown[] {
  if ('elements' in holder) {
    const maybe = holder.elements;
    if (Array.isArray(maybe)) return maybe;
  }
  return [];
}

/** Dig the select_static element out of the card JSON (schema 2.0 body). */
function findSelectStatic(card: object): SelectStatic {
  if (!('body' in card)) throw new Error('card has no body');
  const body = card.body;
  if (typeof body !== 'object' || body === null) throw new Error('card body is not an object');
  for (const el of readElements(body)) {
    if (typeof el !== 'object' || el === null || !('tag' in el)) continue;
    if (el.tag !== 'form') continue;
    for (const inner of readElements(el)) {
      if (isSelectStatic(inner)) return inner;
    }
  }
  throw new Error('no select_static found in card');
}

describe('modelSelectCard', () => {
  it('keeps the options array on select_static (regression: a fix once dropped it and /model became an empty dropdown)', () => {
    const sel = findSelectStatic(modelSelectCard('zhipu-coding-plan', undefined, MODELS));
    expect(Array.isArray(sel.options)).toBe(true);
    expect(sel.options).toHaveLength(2);
  });

  it('preselects the current model by its full selector, not a half id', () => {
    const sel = findSelectStatic(
      modelSelectCard('zhipu-coding-plan', 'zhipu-coding-plan/glm-5.3', MODELS),
    );
    expect(sel.initial_option).toBe('zhipu-coding-plan/glm-5.3');
  });

  it('falls back to the first option when current is not in this provider list', () => {
    const sel = findSelectStatic(
      modelSelectCard('zhipu-coding-plan', 'other/provider-model', MODELS),
    );
    expect(sel.initial_option).toBe('zhipu-coding-plan/glm-5.2');
  });
});
