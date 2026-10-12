import { describe, expect, it, vi } from 'vitest';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig, saveConfig } from './store';
import { log } from '../core/logger';
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

describe('loadConfig 对坏形状的容忍', () => {
  it('合法 JSON 但不是对象（null/数组/数字）→ 返回 {}，不抛', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'cfg-load-'));
    for (const [name, body] of [
      ['null.json', 'null'],
      ['arr.json', '[1,2]'],
      ['num.json', '42'],
      ['str.json', '"x"'],
    ] as Array<[string, string]>) {
      const p = join(dir, name);
      await writeFile(p, body, 'utf8');
      await expect(loadConfig(p)).resolves.toEqual({});
    }
  });

  it('JSON 语法错误 → 返回 {} 不抛（launchd KeepAlive 下原样抛会 10s 一次静默崩溃循环）', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'cfg-load-'));
    const p = join(dir, 'broken.json');
    await writeFile(p, '{"accounts": {"app": ', 'utf8');

    const warn = vi.spyOn(log, 'warn').mockImplementation(() => {});
    try {
      await expect(loadConfig(p)).resolves.toEqual({});
      // 断言放在 restore 前：vitest 的 mockRestore 会连带清空调用记录。
      expect(warn).toHaveBeenCalledWith(
        'config',
        'load-parse-failed',
        expect.objectContaining({ path: p }),
      );
    } finally {
      warn.mockRestore();
    }
  });

  it('文件不存在（ENOENT）→ 返回 {}，不抛', async () => {
    await expect(loadConfig(join(tmpdir(), 'cfg-nope', 'config.json'))).resolves.toEqual({});
  });
});
