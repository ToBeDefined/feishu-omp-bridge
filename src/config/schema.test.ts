import { describe, expect, it } from 'vitest';
import {
  getOmpBinary,
  getOmpModel,
  getOmpSessionDir,
  getOmpThinking,
  getOmpTools,
  isOwner,
  type AppConfig,
} from './schema';

function cfg(preferences: AppConfig['preferences'] = {}): AppConfig {
  return {
    accounts: { app: { id: 'cli_x', secret: 'secret', tenant: 'feishu' } },
    preferences,
  };
}

describe('OMP preferences', () => {
  it('defaults OMP binary to omp', () => {
    expect(getOmpBinary(cfg())).toBe('omp');
  });

  it('trims configured OMP binary and model', () => {
    expect(getOmpBinary(cfg({ ompBinary: ' /opt/bin/omp ' }))).toBe('/opt/bin/omp');
    expect(getOmpModel(cfg({ ompModel: ' gpt-5.5 ' }))).toBe('gpt-5.5');
  });

  it('falls back to legacy Codex binary and model when OMP fields are absent', () => {
    expect(getOmpBinary(cfg({ codexBinary: ' /opt/bin/codex ' }))).toBe('/opt/bin/codex');
    expect(getOmpModel(cfg({ codexModel: ' gpt-5.1 ' }))).toBe('gpt-5.1');
  });

  it('omits empty optional OMP flags', () => {
    expect(getOmpModel(cfg({ ompModel: '   ' }))).toBeUndefined();
    expect(getOmpThinking(cfg({ ompThinking: '   ' }))).toBeUndefined();
    expect(getOmpTools(cfg({ ompTools: '   ' }))).toBeUndefined();
  });

  it('trims OMP thinking, tools, and session dir', () => {
    expect(getOmpThinking(cfg({ ompThinking: ' xhigh ' }))).toBe('xhigh');
    expect(getOmpTools(cfg({ ompTools: ' read,bash ' }))).toBe('read,bash');
    expect(getOmpSessionDir(cfg({ ompSessionDir: ' /tmp/sessions ' }))).toBe('/tmp/sessions');
  });
});

describe('isOwner', () => {
  it('accepts the explicit owner over any other admin', () => {
    const c = cfg({ access: { owner: 'ou_1', admins: ['ou_1', 'ou_2'] } });
    expect(isOwner(c, 'ou_1')).toBe(true);
    expect(isOwner(c, 'ou_2')).toBe(false);
  });

  it('falls back to the first admin when owner is unset', () => {
    const c = cfg({ access: { admins: ['ou_1', 'ou_2'] } });
    expect(isOwner(c, 'ou_1')).toBe(true);
    expect(isOwner(c, 'ou_2')).toBe(false);
  });

  it('refuses everyone when neither owner nor admins is set', () => {
    expect(isOwner(cfg({}), 'ou_1')).toBe(false);
    expect(isOwner(cfg({ access: {} }), 'ou_1')).toBe(false);
  });
});
