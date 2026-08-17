import { describe, expect, it } from 'vitest';
import {
  isSelfBridgeCommand,
  lookupProvider,
  resolveAppSecret,
  resolveEnvRef,
  resolvePlainOrTemplate,
} from './secret-resolver';
import type { AppConfig, SecretRef } from './schema';

function cfg(over: Partial<AppConfig> = {}): AppConfig {
  return {
    accounts: { app: { id: 'cli_x', tenant: 'feishu', secret: '' } },
    ...over,
  } as AppConfig;
}

describe('resolvePlainOrTemplate', () => {
  it('returns literal value', () => {
    expect(resolvePlainOrTemplate('plain-secret')).toBe('plain-secret');
  });

  it('resolves ${VAR} from env', () => {
    process.env.TEST_BRIDGE_SECRET = 'from-env';
    expect(resolvePlainOrTemplate('${TEST_BRIDGE_SECRET}')).toBe('from-env');
    delete process.env.TEST_BRIDGE_SECRET;
  });

  it('throws when ${VAR} not set', () => {
    delete process.env.TEST_BRIDGE_MISSING;
    expect(() => resolvePlainOrTemplate('${TEST_BRIDGE_MISSING}')).toThrow(/not set/);
  });

  it('throws on empty input', () => {
    expect(() => resolvePlainOrTemplate('')).toThrow(/empty/);
  });
});

describe('resolveEnvRef', () => {
  it('returns env var when set', () => {
    process.env.TEST_REF = 'v1';
    expect(resolveEnvRef({ source: 'env', id: 'TEST_REF' }, undefined)).toBe('v1');
    delete process.env.TEST_REF;
  });

  it('throws when env var not set', () => {
    delete process.env.TEST_REF_MISSING;
    expect(() => resolveEnvRef({ source: 'env', id: 'TEST_REF_MISSING' }, undefined)).toThrow(
      /not set/,
    );
  });

  it('enforces provider allowlist', () => {
    process.env.TEST_ALLOW = 'v';
    const pc = { source: "env" as const, allowlist: ["OTHER"] };
    expect(() => resolveEnvRef({ source: 'env', id: 'TEST_ALLOW' }, pc)).toThrow(/allowlist/);
    delete process.env.TEST_ALLOW;
  });

  it('allows allowlisted env var', () => {
    process.env.TEST_ALLOW = 'v';
    const pc = { source: "env" as const, allowlist: ["TEST_ALLOW"] };
    expect(resolveEnvRef({ source: 'env', id: 'TEST_ALLOW' }, pc)).toBe('v');
    delete process.env.TEST_ALLOW;
  });
});

describe('lookupProvider', () => {
  it('returns undefined when no providers configured', () => {
    expect(lookupProvider(undefined, { source: 'env', id: 'x' })).toBeUndefined();
  });

  it('resolves named provider', () => {
    const pc = { name: 'p1', source: 'env' as const };
    const secrets = { providers: { p1: pc } } as AppConfig['secrets'];
    expect(lookupProvider(secrets, { source: 'env', id: 'x', provider: 'p1' })).toBe(pc);
  });

  it('falls back to default provider for the source', () => {
    const pc = { name: 'default', source: 'env' as const };
    const secrets = {
      providers: { def: pc },
      defaults: { env: 'def' },
    } as AppConfig['secrets'];
    expect(lookupProvider(secrets, { source: 'env', id: 'x' })).toBe(pc);
  });
});

describe('isSelfBridgeCommand', () => {
  it('detects self-referential bridge command', () => {
    expect(isSelfBridgeCommand('node', ['node', 'feishu-omp-bridge.mjs', 'secrets', 'get'])).toBe(
      true,
    );
  });

  it('rejects non-bridge commands', () => {
    expect(isSelfBridgeCommand('node', ['node', 'server.js'])).toBe(false);
  });

  it('rejects bridge commands without secrets-get args', () => {
    expect(isSelfBridgeCommand('node', ['node', 'feishu-omp-bridge.mjs', 'ps'])).toBe(false);
  });
});

describe('resolveAppSecret', () => {
  it('resolves literal secret from config', async () => {
    const c = cfg({ accounts: { app: { id: 'cli_x', tenant: 'feishu', secret: 'literal' } } });
    expect(await resolveAppSecret(c)).toBe('literal');
  });

  it('resolves env secret ref', async () => {
    process.env.TEST_APP_SECRET = 'env-secret';
    const ref: SecretRef = { source: 'env', id: 'TEST_APP_SECRET' };
    const c = cfg({ accounts: { app: { id: 'cli_x', tenant: 'feishu', secret: ref } } });
    expect(await resolveAppSecret(c)).toBe('env-secret');
    delete process.env.TEST_APP_SECRET;
  });

  it('throws when secret missing', async () => {
    const c = cfg({ accounts: { app: { id: 'cli_x', tenant: 'feishu', secret: '' } } });
    await expect(resolveAppSecret(c)).rejects.toThrow(/missing/);
  });
});
