// Real-network integration test for the file-send path (the same code path
// feishu_send_file uses). Uploads a temp file to the configured Feishu app
// and sends it to the test chat. Requires live credentials — skipped unless
// RUN_INTEGRATION=1.
import { readFile, writeFile, rm } from 'node:fs/promises';
import { createLarkChannel, Domain, LoggerLevel } from '@larksuiteoapi/node-sdk';
import { describe, expect, it } from 'vitest';
import { resolveAppSecret } from '../config/secret-resolver';
import { loadConfig } from '../config/store';

describe('feishu_send_file real integration', () => {
  it('uploads and sends a file to the configured chat', async () => {
    if (process.env.RUN_INTEGRATION !== '1') {
      return; // skip by default
    }
    const cfg = await loadConfig();
    const secret = await resolveAppSecret(cfg);
    const channel = createLarkChannel({
      appId: cfg.accounts.app.id,
      appSecret: secret,
      domain: cfg.accounts.app.tenant === 'lark' ? Domain.Lark : Domain.Feishu,
      source: 'sendfile-integration',
      loggerLevel: LoggerLevel.info,
      logger: { error: () => {}, warn: () => {}, info: () => {}, debug: () => {}, trace: () => {} },
    });
    await channel.connect();
    try {
      const tmp = '/tmp/sendfile-integration.txt';
      await writeFile(tmp, `integration test ${Date.now()}`);
      const buffer = await readFile(tmp);
      const up = await channel.rawClient.im.v1.file.create({
        data: { file_type: 'stream', file_name: 'sendfile-integration.txt', file: buffer },
      });
      expect(up?.file_key).toBeTruthy();
      const chatId = cfg.preferences?.access?.admins?.[0] ? undefined : undefined;
      // Use a known chat: the first admin's p2p is not addressable here, so
      // this sends to the bridge's default chat via config-less approach.
      // For a real test, set SEND_TO_CHAT env.
      const target = process.env.SEND_TO_CHAT ?? 'oc_95f09e52e2a7b9215fbc709eba3aa8bf';
      await channel.rawClient.im.v1.message.create({
        params: { receive_id_type: 'chat_id' },
        data: { receive_id: target, msg_type: 'file', content: JSON.stringify({ file_key: up.file_key }) },
      });
      await rm(tmp, { force: true });
    } finally {
      await channel.disconnect();
    }
  }, 30_000);
});
