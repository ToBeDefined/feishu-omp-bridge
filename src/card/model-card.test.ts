import { describe, expect, it } from 'vitest';
import { THINKING_FOLLOW_DEFAULT, modelProviderCard, modelSelectCard } from './model-card';
import { OMP_THINKING_LEVELS } from '../config/schema';

const MODELS = [
  { provider: 'zhipu-coding-plan', selector: 'zhipu-coding-plan/glm-5.2', name: 'GLM-5.2' },
  { provider: 'zhipu-coding-plan', selector: 'zhipu-coding-plan/glm-5.3', name: 'GLM-5.3' },
];

interface SelectStatic {
  name?: unknown;
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

function findSelects(card: object): SelectStatic[] {
  if (!('body' in card)) throw new Error('card has no body');
  const body = card.body;
  if (typeof body !== 'object' || body === null) throw new Error('card body is not an object');
  const found: SelectStatic[] = [];
  for (const el of readElements(body)) {
    if (typeof el !== 'object' || el === null || !('tag' in el)) continue;
    if (el.tag !== 'form') continue;
    for (const inner of readElements(el)) {
      if (isSelectStatic(inner)) found.push(inner);
    }
  }
  return found;
}

function findSelect(card: object, name: string): SelectStatic {
  const sel = findSelects(card).find((s) => s.name === name);
  if (!sel) throw new Error(`no select_static named ${name}`);
  return sel;
}

function cardMarkdown(card: object): string {
  if (!('body' in card)) return '';
  const body = card.body;
  if (typeof body !== 'object' || body === null) return '';
  return readElements(body)
    .filter((el): el is { tag: string; content?: string } =>
      typeof el === 'object' && el !== null && 'tag' in el && el.tag === 'markdown',
    )
    .map((el) => el.content ?? '')
    .join('\n');
}

describe('modelSelectCard', () => {
  it('keeps the options array on select_static (regression: a fix once dropped it and /model became an empty dropdown)', () => {
    const sel = findSelect(modelSelectCard('zhipu-coding-plan', undefined, MODELS), 'model_selector');
    expect(Array.isArray(sel.options)).toBe(true);
    expect(sel.options).toHaveLength(2);
  });

  it('preselects the current model by its full selector, not a half id', () => {
    const sel = findSelect(
      modelSelectCard('zhipu-coding-plan', 'zhipu-coding-plan/glm-5.3', MODELS),
      'model_selector',
    );
    expect(sel.initial_option).toBe('zhipu-coding-plan/glm-5.3');
  });

  it('falls back to the first option when current is not in this provider list', () => {
    const sel = findSelect(
      modelSelectCard('zhipu-coding-plan', 'other/provider-model', MODELS),
      'model_selector',
    );
    expect(sel.initial_option).toBe('zhipu-coding-plan/glm-5.2');
  });

  it('includes a thinking-level select next to the model picker', () => {
    const card = modelSelectCard('zhipu-coding-plan', undefined, MODELS, 'high');
    const names = findSelects(card).map((s) => s.name);
    expect(names).toEqual(['model_selector', 'thinking_level']);
    const thinking = findSelect(card, 'thinking_level');
    expect(thinking.initial_option).toBe('high');
    expect(thinking.options).toHaveLength(1 + OMP_THINKING_LEVELS.length);
    expect(thinking.options?.[0]).toEqual({
      text: { tag: 'plain_text', content: '跟随 OMP 默认' },
      value: THINKING_FOLLOW_DEFAULT,
    });
  });

  it('preselects follow-default when thinking is unset', () => {
    const thinking = findSelect(
      modelSelectCard('zhipu-coding-plan', undefined, MODELS),
      'thinking_level',
    );
    expect(thinking.initial_option).toBe(THINKING_FOLLOW_DEFAULT);
  });
});

describe('modelProviderCard', () => {
  it('shows the current model and thinking on the provider chooser', () => {
    const md = cardMarkdown(modelProviderCard('p/a', [{ provider: 'p', count: 1 }], [], [], 'medium'));
    expect(md).toContain('当前模型:`p/a`');
    expect(md).toContain('思考强度:`medium`');
  });
});
