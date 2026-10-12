import { describe, expect, it } from 'vitest';
import {
  OMP_UI_MARKER,
  OMP_UI_VALUE_FIELD,
  renderOmpUiRequestCard,
  renderOmpUiResultCard,
  responseFromOmpUiAction,
} from './omp-ui';

describe('OMP UI cards', () => {
  it('renders select requests with callback marker and options', () => {
    const card = renderOmpUiRequestCard({
      id: 'ui-1',
      method: 'select',
      title: 'Pick one',
      options: ['alpha', 'beta'],
      timeout: 1200,
    });

    const json = JSON.stringify(card);
    expect(json).toContain('select_static');
    expect(json).toContain('alpha');
    expect(json).toContain('beta');
    expect(json).toContain(OMP_UI_MARKER);
    expect(json).toContain('ui-1');
  });

  it('renders confirm requests as column_set buttons (no unsupported action tag)', () => {
    const card = renderOmpUiRequestCard({
      id: 'ui-2',
      method: 'confirm',
      title: 'Confirm',
      message: 'Sure?',
    });
    const json = JSON.stringify(card);
    expect(json).toContain('column_set');
    expect(json).not.toContain('"tag":"action"');
    expect(json).toContain('确认');
    expect(json).toContain('否');
    expect(json).toContain('取消');
  });

  it('turns confirm actions into OMP UI responses', () => {
    expect(responseFromOmpUiAction({ [OMP_UI_MARKER]: true, method: 'confirm', action: 'confirm' }, undefined)).toEqual({
      confirmed: true,
    });
    expect(responseFromOmpUiAction({ [OMP_UI_MARKER]: true, method: 'confirm', action: 'deny' }, undefined)).toEqual({
      confirmed: false,
    });
    expect(responseFromOmpUiAction({ [OMP_UI_MARKER]: true, method: 'input', action: 'cancel' }, undefined)).toEqual({
      cancelled: true,
    });
  });

  it('turns form submissions into string value responses', () => {
    expect(responseFromOmpUiAction(
      { [OMP_UI_MARKER]: true, method: 'input', action: 'submit' },
      { [OMP_UI_VALUE_FIELD]: 'hello' },
    )).toEqual({ value: 'hello' });

    expect(responseFromOmpUiAction(
      { [OMP_UI_MARKER]: true, method: 'select', action: 'submit' },
      { [OMP_UI_VALUE_FIELD]: ['first', 'ignored'] },
    )).toEqual({ value: 'first' });
  });

  it('echoes the submitted value on the result card (select / input / editor)', () => {
    const card = renderOmpUiResultCard('选择模型', 'submitted', 'gpt-5');
    const json = JSON.stringify(card);
    expect(json).toContain('已提交');
    expect(json).toContain('gpt-5');
  });

  it('echoes the confirm choice on the result card', () => {
    const card = renderOmpUiResultCard('确认发布', 'submitted', '确认');
    expect(JSON.stringify(card)).toContain('确认');
    const denied = renderOmpUiResultCard('确认发布', 'submitted', '否');
    expect(JSON.stringify(denied)).toContain('否');
  });

  it('escapes and truncates the echoed value, and omits it when absent', () => {
    type ResultCard = { body: { elements: Array<{ content?: string }> } };
    const textOf = (card: object): string =>
      (card as unknown as ResultCard).body.elements.map((e) => e.content ?? '').join('\n');

    const long = textOf(renderOmpUiResultCard('t', 'submitted', 'a'.repeat(500)));
    expect(long).toContain('…');

    const escaped = textOf(renderOmpUiResultCard('t', 'submitted', 'a*b_c'));
    expect(escaped).toContain('a\\*b');

    const none = JSON.stringify(renderOmpUiResultCard('t', 'cancelled'));
    expect(none).not.toContain('已提交：');
  });

  it('states that a timeout falls back to cancel', () => {
    const card = renderOmpUiRequestCard({
      id: 'ui-3',
      method: 'select',
      title: 'Pick',
      options: ['a'],
      timeout: 60_000,
    });
    expect(JSON.stringify(card)).toContain('超时后按取消处理');
  });
});
