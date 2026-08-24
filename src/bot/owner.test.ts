import { describe, expect, it, vi } from 'vitest';
import type { Mock } from 'vitest';
import type { LarkChannel } from '@larksuiteoapi/node-sdk';
import type { AppConfig } from '../config/schema';
import { resolveOwner } from './owner';

vi.mock('../core/logger', () => ({
  log: { info: vi.fn(), warn: vi.fn(), fail: vi.fn() },
}));

function makeChannel(get: Mock): LarkChannel {
  return {
    rawClient: {
      application: { application: { get } },
    },
  } as unknown as LarkChannel;
}

function makeCfg(owner?: string): AppConfig {
  return {
    accounts: { app: { id: 'cli_x', secret: 's', tenant: 'feishu' } },
    preferences: owner ? { access: { owner } } : {},
  };
}

describe('resolveOwner', () => {
  it('keeps an explicitly configured owner and skips the API call', async () => {
    const get = vi.fn();
    const cfg = makeCfg('ou_manual');
    await resolveOwner(makeChannel(get), cfg);
    expect(get).not.toHaveBeenCalled();
    expect(cfg.preferences?.access?.owner).toBe('ou_manual');
  });

  it('writes the Feishu app creator_id when owner is unset', async () => {
    const get = vi.fn().mockResolvedValue({
      data: { app: { creator_id: 'ou_creator' } },
    });
    const cfg = makeCfg();
    await resolveOwner(makeChannel(get), cfg);
    expect(get).toHaveBeenCalledWith({
      params: { lang: 'zh_cn' },
      path: { app_id: 'me' },
    });
    expect(cfg.preferences?.access?.owner).toBe('ou_creator');
  });

  it('leaves owner unset when the API call fails', async () => {
    const get = vi.fn().mockRejectedValue(new Error('boom'));
    const cfg = makeCfg();
    await resolveOwner(makeChannel(get), cfg);
    expect(cfg.preferences?.access?.owner).toBeUndefined();
  });
});
