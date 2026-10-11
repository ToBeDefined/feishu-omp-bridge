import { describe, expect, it } from 'vitest';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig, saveConfig } from './store';
import type { AppConfig } from './schema';

function cfgWith(over: Partial<AppConfig> = {}): AppConfig {
  return {
    accounts: {
      app: {
        id: 'cli_x',
        secret: { source: 'exec', provider: 'bridge', id: 'app-cli_x' },
        tenant: 'feishu',
      },
    },
    secrets: { providers: { bridge: { source: 'exec', command: '/tmp/getter', args: [] } } },
    ...over,
  } as AppConfig;
}

describe('saveConfig 的凭据护栏', () => {
  it('refuses to overwrite a config with one that dropped accounts', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'cfg-store-'));
    const path = join(dir, 'config.json');
    await writeFile(path, JSON.stringify(cfgWith({ preferences: { messageReply: 'card' } })), 'utf8');
    const before = await readFile(path, 'utf8');

    // 事故复现：只有 preferences 的假 cfg（冒烟脚本曾拿它覆盖了真配置）。
    await expect(
      saveConfig({ preferences: { ompModel: 'x' } } as unknown as AppConfig, path),
    ).rejects.toThrow(/accounts\.app\.id/);
    // 文件原样保留 —— 凭据还在。
    expect(await readFile(path, 'utf8')).toBe(before);
  });

  it('writes normally when the config carries credentials', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'cfg-store-'));
    const path = join(dir, 'config.json');
    await saveConfig(cfgWith({ preferences: { messageReply: 'markdown' } }), path);
    const reloaded = (await loadConfig(path)) as AppConfig;
    expect(reloaded.accounts.app.id).toBe('cli_x');
    expect(reloaded.preferences?.messageReply).toBe('markdown');
  });
});
