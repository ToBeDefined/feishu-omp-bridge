// Real-network integration test for the file-send path (the same code path
// feishu_send_file uses). Uploads a temp file to the configured Feishu app
// and sends it to the test chat.
//
// Env required (test is skipped unless all are present):
//   RUN_INTEGRATION=1     run the real-network test
//   SEND_TO_CHAT=<chatId> chat to send the file to (must be a chat the bot
//                         can address — e.g. a group it belongs to)
import { readFile, writeFile, rm } from 'node:fs/promises';
import { createLarkChannel, Domain, LoggerLevel } from '@larksuiteoapi/node-sdk';
import { describe, expect, it } from 'vitest';
import { resolveAppSecret } from '../config/secret-resolver';
import { loadConfig } from '../config/store';
import type { AppConfig } from '../config/schema';

describe('feishu_send_file real integration', () => {
  it('uploads and sends a file to the configured chat', async () => {
    if (process.env.RUN_INTEGRATION !== '1') {
      return; // skip by default
    }
    const cfg = await loadConfig();
    const secret = await resolveAppSecret(cfg as AppConfig);
    const channel = createLarkChannel({
      appId: cfg.accounts!.app.id,
      appSecret: secret,
      domain: cfg.accounts!.app.tenant === 'lark' ? Domain.Lark : Domain.Feishu,
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
      const target = process.env.SEND_TO_CHAT;
      if (!target) {
        throw new Error(
          'SEND_TO_CHAT env is required to run the file-send integration test',
        );
      }
      await channel.rawClient.im.v1.message.create({
        params: { receive_id_type: 'chat_id' },
        data: { receive_id: target, msg_type: 'file', content: JSON.stringify({ file_key: up!.file_key }) },
      });
      await rm(tmp, { force: true });
    } finally {
      await channel.disconnect();
    }
  }, 30_000);
});
