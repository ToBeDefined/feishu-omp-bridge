import { describe, expect, it } from 'vitest';
import {
  OMP_UI_MARKER,
  OMP_UI_VALUE_FIELD,
  renderOmpUiRequestCard,
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
});
