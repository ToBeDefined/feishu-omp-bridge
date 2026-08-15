import type { LarkChannel } from '@larksuiteoapi/node-sdk';
import { describe, expect, it } from 'vitest';
import { createFeishuHostIntegration } from './feishu-host';

function fakeChannel(sent: unknown[]): LarkChannel {
  return {
    async send(...args: unknown[]) {
      sent.push(args);
    },
  } as unknown as LarkChannel;
}

describe('createFeishuHostIntegration', () => {
  it('exposes Feishu context and send/reply host tools', async () => {
    const sent: unknown[] = [];
    const host = createFeishuHostIntegration(fakeChannel(sent), {
      scope: 'chat-1:thread-1',
      chatId: 'chat-1',
      threadId: 'thread-1',
      replyToMessageId: 'msg-1',
      cwd: '/repo',
    });

    expect(host.tools.map((tool) => tool.definition.name)).toEqual([
      'feishu_current_context',
      'feishu_send_message',
      'feishu_reply_message',
      'feishu_get_message',
      'feishu_send_file',
    ]);
    expect(host.uriSchemes[0]?.definition.scheme).toBe('feishu');

    const context = await host.tools[0]!.execute({});
    expect(JSON.stringify(context.result)).toContain('chat-1:thread-1');

    await expect(host.tools[1]!.execute({ content: 'hello' })).resolves.toEqual({
      result: { content: [{ type: 'text', text: 'sent message to chat-1' }] },
    });
    await expect(host.tools[2]!.execute({ content: 'reply' })).resolves.toEqual({
      result: { content: [{ type: 'text', text: 'replied to msg-1' }] },
    });
    expect(sent).toEqual([
      ['chat-1', { markdown: 'hello' }, { replyInThread: true }],
      ['chat-1', { markdown: 'reply' }, { replyTo: 'msg-1', replyInThread: true }],
    ]);
  });

  it('serves current context through feishu URI scheme', async () => {    const host = createFeishuHostIntegration(fakeChannel([]), {
      scope: 'chat-1',
      chatId: 'chat-1',
      cwd: '/repo',
    });

    await expect(host.uriSchemes[0]!.handle({ operation: 'read', url: 'feishu://current/context' })).resolves.toMatchObject({
      contentType: 'application/json',
    });
    await expect(host.uriSchemes[0]!.handle({ operation: 'write', url: 'feishu://current/context' })).resolves.toMatchObject({
      isError: true,
    });
  });
});

describe('feishu_send_file', () => {
  it('uploads images via image.create and sends an image message', async () => {
    const sent: unknown[] = [];
    const uploaded: unknown[] = [];
    const channel = {
      send: async (...args: unknown[]) => sent.push(args),
      rawClient: {
        im: {
          v1: {
            image: { create: async (p: unknown) => { uploaded.push(p); return { image_key: 'img_1' }; } },
            file: { create: async () => { throw new Error('should not call file for images'); } },
            message: { create: async (p: unknown) => { sent.push(p); return {}; } },
          },
        },
      },
    } as unknown as LarkChannel;
    const host = createFeishuHostIntegration(channel, { scope: 's', chatId: 'chat-1', cwd: '/x' });
    const tool = host.tools.find((t) => t.definition.name === 'feishu_send_file')!;
    const tmp = '/tmp/test-image.png';
    await import('node:fs/promises').then((fs) => fs.writeFile(tmp, Buffer.from([0x89, 0x50, 0x4e, 0x47])));
    const res = await tool.execute({ path: tmp });
    expect(JSON.stringify(res.result)).toContain('sent image');
    const up = uploaded[0] as { data: { image_type: string; image: Buffer } };
    expect(up.data.image_type).toBe('message');
    const msg = sent[0] as { data: { msg_type: string; content: string } };
    expect(msg.data.msg_type).toBe('image');
    expect(JSON.parse(msg.data.content).image_key).toBe('img_1');
    await import('node:fs/promises').then((fs) => fs.rm(tmp, { force: true }));
  });

  it('rejects empty files', async () => {
    const channel = {
      send: async () => {},
      rawClient: { im: { v1: {} } },
    } as unknown as LarkChannel;
    const host = createFeishuHostIntegration(channel, { scope: 's', chatId: 'chat-1', cwd: '/x' });
    const tool = host.tools.find((t) => t.definition.name === 'feishu_send_file')!;
    const tmp = '/tmp/test-empty.png';
    await import('node:fs/promises').then((fs) => fs.writeFile(tmp, Buffer.alloc(0)));
    await expect(tool.execute({ path: tmp })).rejects.toThrow('empty file');
    await import('node:fs/promises').then((fs) => fs.rm(tmp, { force: true }));
  });
});
