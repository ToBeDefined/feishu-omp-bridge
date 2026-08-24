import type { LarkChannel } from '@larksuiteoapi/node-sdk';
import type { AppConfig } from '../config/schema';
import { log } from '../core/logger';

/**
 * Auto-detect the bot owner from the Feishu app's `creator_id` and write it
 * into `cfg` (in-memory only — never persisted, so each startup re-derives
 * it). An explicitly configured `access.owner` always wins; the fetch is
 * best-effort and a failure simply leaves the owner unset, letting `isOwner`
 * fall back to `admins[0]`.
 */
export async function resolveOwner(channel: LarkChannel, cfg: AppConfig): Promise<void> {
  if (cfg.preferences?.access?.owner) return;
  try {
    const res = await channel.rawClient.application.application.get({
      params: { lang: 'zh_cn' },
      path: { app_id: 'me' },
    });
    const creator = res.data?.app?.creator_id;
    if (!creator) return;
    cfg.preferences ??= {};
    cfg.preferences.access ??= {};
    cfg.preferences.access.owner = creator;
    log.info('owner', 'auto-detected', { owner: creator.slice(-6) });
  } catch (err) {
    log.warn('owner', 'fetch-failed', { err: String(err) });
  }
}
