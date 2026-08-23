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
      'feishu_list_messages',
      'feishu_send_file',
      'feishu_send_card',
      'feishu_recall_message',
      'feishu_add_reaction',
      'feishu_view_image',
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

describe('feishu_recall_message', () => {
  it('deletes the message via im.v1.message.delete', async () => {
    const deleted: unknown[] = [];
    const channel = {
      rawClient: {
        im: { v1: { message: { delete: async (p: unknown) => { deleted.push(p); return {}; } } } },
      },
    } as unknown as LarkChannel;
    const host = createFeishuHostIntegration(channel, { scope: 's', chatId: 'chat-1', cwd: '/x' });
    const tool = host.tools.find((t) => t.definition.name === 'feishu_recall_message')!;
    const res = await tool.execute({ messageId: 'om_123' });
    expect(JSON.stringify(res.result)).toContain('recalled om_123');
    expect(deleted[0]).toEqual({ path: { message_id: 'om_123' } });
  });

  it('requires a messageId', async () => {
    const channel = { rawClient: { im: { v1: {} } } } as unknown as LarkChannel;
    const host = createFeishuHostIntegration(channel, { scope: 's', chatId: 'chat-1', cwd: '/x' });
    const tool = host.tools.find((t) => t.definition.name === 'feishu_recall_message')!;
    await expect(tool.execute({})).rejects.toThrow('messageId is required');
  });
});

describe('feishu_view_image', () => {
  it('injects a local image into the active run', async () => {
    const injected: unknown[] = [];
    const activeRuns = {
      has: () => true,
      submitPrompt: async (...args: unknown[]) => { injected.push(args); return true; },
    };
    const host = createFeishuHostIntegration({} as unknown as LarkChannel, {
      scope: 'chat-1', chatId: 'chat-1', cwd: '/x', activeRuns: activeRuns as never,
    });
    const tool = host.tools.find((t) => t.definition.name === 'feishu_view_image')!;
    const tmp = '/tmp/view-image-test.png';
    await import('node:fs/promises').then((fs) => fs.writeFile(tmp, Buffer.from([0x89, 0x50, 0x4e, 0x47])));
    const res = await tool.execute({ path: tmp });
    expect(JSON.stringify(res.result)).toContain('已注入图片');
    expect(injected[0]).toEqual(['chat-1', 'follow_up', expect.stringContaining(tmp), [tmp]]);
    await import('node:fs/promises').then((fs) => fs.rm(tmp, { force: true }));
  });

  it('rejects non-image files', async () => {
    const host = createFeishuHostIntegration({} as unknown as LarkChannel, {
      scope: 'chat-1', chatId: 'chat-1', cwd: '/x',
    });
    const tool = host.tools.find((t) => t.definition.name === 'feishu_view_image')!;
    await expect(tool.execute({ path: '/tmp/x.txt' })).rejects.toThrow('not an image file');
  });

  it('fails when no active run exists', async () => {
    const host = createFeishuHostIntegration({} as unknown as LarkChannel, {
      scope: 'chat-1', chatId: 'chat-1', cwd: '/x', activeRuns: { has: () => false } as never,
    });
    const tool = host.tools.find((t) => t.definition.name === 'feishu_view_image')!;
    const tmp = '/tmp/view-image-test.png';
    await import('node:fs/promises').then((fs) => fs.writeFile(tmp, Buffer.from([0x89, 0x50, 0x4e, 0x47])));
    await expect(tool.execute({ path: tmp })).rejects.toThrow('no active run');
    await import('node:fs/promises').then((fs) => fs.rm(tmp, { force: true }));
  });
});

describe('feishu_send_card', () => {
  it('builds and sends an agent callback card, replying to the triggering message', async () => {
    const cardCreated: unknown[] = [];
    const replies: unknown[] = [];
    const channel = {
      rawClient: {
        cardkit: {
          v1: {
            card: { create: async (p: unknown) => { cardCreated.push(p); return { data: { card_id: 'card_1' } }; } },
          },
        },
        im: {
          v1: { message: { reply: async (p: unknown) => { replies.push(p); return { data: { message_id: 'om_sent' } }; } } },
        },
      },
    } as unknown as LarkChannel;
    const host = createFeishuHostIntegration(channel, {
      scope: 'chat-1', chatId: 'chat-1', replyToMessageId: 'msg-1', cwd: '/x',
    });
    const tool = host.tools.find((t) => t.definition.name === 'feishu_send_card')!;

    const res = await tool.execute({
      title: '确认发布',
      text: '要发布吗？',
      buttons: [{ label: '发布', value: { action: 'deploy' } }],
    });

    expect(JSON.stringify(res.result)).toContain('om_sent');
    const cardCall = cardCreated[0] as { data: { type: string; data: string } };
    expect(cardCall.data.type).toBe('card_json');
    const card = JSON.parse(cardCall.data.data);
    expect(card.body.elements[1].columns[0].elements[0].behaviors[0].value).toEqual({
      action: 'deploy', __codex_cb: true,
    });
    expect(replies[0]).toEqual({ path: { message_id: 'msg-1' }, data: { msg_type: 'interactive', content: expect.any(String) } });
  });

  it('requires title and buttons', async () => {
    const host = createFeishuHostIntegration({} as unknown as LarkChannel, {
      scope: 'chat-1', chatId: 'chat-1', cwd: '/x',
    });
    const tool = host.tools.find((t) => t.definition.name === 'feishu_send_card')!;
    await expect(tool.execute({ text: 'x', buttons: [{ label: 'a', value: {} }] })).rejects.toThrow('title is required');
    await expect(tool.execute({ title: 't', text: 'x' })).rejects.toThrow('at least one button');
  });
});

describe('feishu_list_messages', () => {
  it('lists recent messages with normalized text content', async () => {
    const listed: unknown[] = [];
    const channel = {
      rawClient: {
        im: {
          v1: {
            message: {
              list: async (p: unknown) => {
                listed.push(p);
                return {
                  data: {
                    items: [
                      {
                        message_id: 'om_1',
                        msg_type: 'text',
                        create_time: '1720000000000',
                        sender: { id: 'ou_1', sender_name: 'alice' },
                        body: { content: JSON.stringify({ text: 'hello world' }) },
                      },
                      {
                        message_id: 'om_2',
                        msg_type: 'image',
                        create_time: '1719990000000',
                        sender: { id: 'ou_2', sender_name: 'bob' },
                        body: { content: JSON.stringify({ image_key: 'img_1' }) },
                      },
                    ],
                  },
                };
              },
            },
          },
        },
      },
    } as unknown as LarkChannel;
    const host = createFeishuHostIntegration(channel, { scope: 's', chatId: 'chat-1', cwd: '/x' });
    const tool = host.tools.find((t) => t.definition.name === 'feishu_list_messages')!;

    const res = await tool.execute({ limit: 10 });
    const out = JSON.parse(JSON.stringify(res.result));
    const messages = out.content[0].text ? JSON.parse(out.content[0].text).messages : [];
    expect(messages).toHaveLength(2);
    expect(messages[0].content).toBe('hello world');
    expect(messages[0].senderName).toBe('alice');
    expect(messages[1].content).toContain('[image]');
    const call = listed[0] as { params: Record<string, unknown> };
    expect(call.params.container_id).toBe('chat-1');
    expect(call.params.page_size).toBe(10);
  });

  it('uses the thread container when the scope is a topic', async () => {
    const listed: unknown[] = [];
    const channel = {
      rawClient: {
        im: {
          v1: {
            message: {
              list: async (p: unknown) => {
                listed.push(p);
                return { data: { items: [] } };
              },
            },
          },
        },
      },
    } as unknown as LarkChannel;
    const host = createFeishuHostIntegration(channel, {
      scope: 'chat-1:thread-1', chatId: 'chat-1', threadId: 'thread-1', cwd: '/x',
    });
    const tool = host.tools.find((t) => t.definition.name === 'feishu_list_messages')!;
    await tool.execute({});
    const call = listed[0] as { params: Record<string, unknown> };
    expect(call.params.container_id_type).toBe('thread');
    expect(call.params.container_id).toBe('thread-1');
  });
});

describe('feishu_add_reaction', () => {
  it('adds an OK reaction to the triggering message by default', async () => {
    const reacted: unknown[] = [];
    const channel = {
      rawClient: {
        im: {
          v1: {
            messageReaction: {
              create: async (p: unknown) => {
                reacted.push(p);
                return { data: { reaction_id: 'r_1' } };
              },
            },
          },
        },
      },
    } as unknown as LarkChannel;
    const host = createFeishuHostIntegration(channel, {
      scope: 's', chatId: 'chat-1', replyToMessageId: 'msg-1', cwd: '/x',
    });
    const tool = host.tools.find((t) => t.definition.name === 'feishu_add_reaction')!;

    const res = await tool.execute({});
    expect(JSON.stringify(res.result)).toContain('added reaction OK');
    const call = reacted[0] as { path: { message_id: string }; data: { reaction_type: { emoji_type: string } } };
    expect(call.path.message_id).toBe('msg-1');
    expect(call.data.reaction_type.emoji_type).toBe('OK');
  });

  it('reports failure when the reaction call fails', async () => {
    const channel = {
      rawClient: {
        im: {
          v1: {
            messageReaction: { create: async () => ({ data: {} }) },
          },
        },
      },
    } as unknown as LarkChannel;
    const host = createFeishuHostIntegration(channel, {
      scope: 's', chatId: 'chat-1', replyToMessageId: 'msg-1', cwd: '/x',
    });
    const tool = host.tools.find((t) => t.definition.name === 'feishu_add_reaction')!;
    const res = await tool.execute({});
    expect((res as { isError?: boolean }).isError).toBe(true);
  });
});
