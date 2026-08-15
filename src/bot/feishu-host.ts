import type { LarkChannel } from '@larksuiteoapi/node-sdk';
import { readFile } from 'node:fs/promises';
import { basename, extname } from 'node:path';
import type { AgentHostTool, AgentHostUriScheme } from '../agent/types';
import { fetchQuotedContext } from './quote';

export interface FeishuHostContext {
  scope: string;
  chatId: string;
  threadId?: string;
  replyToMessageId?: string;
  cwd: string;
}

export interface FeishuHostIntegration {
  tools: AgentHostTool[];
  uriSchemes: AgentHostUriScheme[];
}

export function createFeishuHostIntegration(
  channel: LarkChannel,
  ctx: FeishuHostContext,
): FeishuHostIntegration {
  return {
    tools: [
      currentContextTool(ctx),
      sendMessageTool(channel, ctx),
      replyMessageTool(channel, ctx),
      getMessageTool(channel),
      sendFileTool(channel, ctx),
      recallMessageTool(channel),
    ],
    uriSchemes: [feishuUriScheme(channel, ctx)],
  };
}

function currentContextTool(ctx: FeishuHostContext): AgentHostTool {
  return {
    definition: {
      name: 'feishu_current_context',
      label: 'Feishu current context',
      description: 'Return the current Feishu chat/topic context for this bridge run.',
      parameters: objectSchema({}),
    },
    async execute() {
      return { result: jsonResult(ctx) };
    },
  };
}

function sendMessageTool(channel: LarkChannel, ctx: FeishuHostContext): AgentHostTool {
  return {
    definition: {
      name: 'feishu_send_message',
      label: 'Send Feishu message',
      description: 'Send a markdown message to the current Feishu chat or a specified chat_id.',
      parameters: objectSchema({
        content: { type: 'string', description: 'Markdown content to send.' },
        chatId: { type: 'string', description: 'Optional target chat_id. Defaults to the current chat.' },
      }, ['content']),
    },
    async execute(args) {
      const content = requiredString(args, 'content');
      const chatId = optionalString(args, 'chatId') ?? ctx.chatId;
      await channel.send(chatId, { markdown: content }, ctx.threadId && chatId === ctx.chatId ? { replyInThread: true } : undefined);
      return { result: textResult(`sent message to ${chatId}`) };
    },
  };
}

function replyMessageTool(channel: LarkChannel, ctx: FeishuHostContext): AgentHostTool {
  return {
    definition: {
      name: 'feishu_reply_message',
      label: 'Reply in Feishu',
      description: 'Reply with markdown to the triggering Feishu message or to a specified message_id.',
      parameters: objectSchema({
        content: { type: 'string', description: 'Markdown reply content.' },
        messageId: { type: 'string', description: 'Optional message_id to reply to. Defaults to the triggering message.' },
      }, ['content']),
    },
    async execute(args) {
      const content = requiredString(args, 'content');
      const messageId = optionalString(args, 'messageId') ?? ctx.replyToMessageId;
      if (!messageId) throw new Error('messageId is required when no triggering message is available');
      await channel.send(ctx.chatId, { markdown: content }, {
        replyTo: messageId,
        ...(ctx.threadId ? { replyInThread: true } : {}),
      });
      return { result: textResult(`replied to ${messageId}`) };
    },
  };
}

function getMessageTool(channel: LarkChannel): AgentHostTool {
  return {
    definition: {
      name: 'feishu_get_message',
      label: 'Get Feishu message',
      description: 'Fetch and normalize a Feishu message by message_id. Useful for quoted messages, cards, and forwarded messages.',
      parameters: objectSchema({
        messageId: { type: 'string', description: 'Feishu/Lark message_id to fetch.' },
      }, ['messageId']),
    },
    async execute(args) {
      const messageId = requiredString(args, 'messageId');
      const message = await fetchQuotedContext(channel, messageId);
      if (!message) return { result: textResult(`message not found or inaccessible: ${messageId}`), isError: true };
      return { result: jsonResult(message) };
    },
  };
}

const IMAGE_EXTS = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp', '.tiff', '.ico']);
// File types accepted by im.v1.file.create; anything else falls back to
// 'stream' (which covers most binary payloads).
const FILE_TYPES: Record<string, string> = {
  '.opus': 'opus',
  '.mp4': 'mp4',
  '.pdf': 'pdf',
  '.doc': 'doc',
  '.docx': 'doc',
  '.xls': 'xls',
  '.xlsx': 'xls',
  '.ppt': 'ppt',
  '.pptx': 'ppt',
};

function sendFileTool(channel: LarkChannel, ctx: FeishuHostContext): AgentHostTool {
  return {
    definition: {
      name: 'feishu_send_file',
      label: 'Send Feishu file or image',
      description:
        'Upload a local file or image and send it to the current Feishu chat (or a specified chat_id). Use this to deliver generated artifacts — reports, screenshots, logs, source files — back to the user. Images are sent as images; other files are sent as attachments.',
      parameters: objectSchema({
        path: { type: 'string', description: 'Local filesystem path to the file to send.' },
        fileName: { type: 'string', description: 'Optional display file name. Defaults to the basename of path.' },
        chatId: { type: 'string', description: 'Optional target chat_id. Defaults to the current chat.' },
      }, ['path']),
    },
    async execute(args) {
      const path = requiredString(args, 'path');
      const fileName = optionalString(args, 'fileName') ?? basename(path);
      const chatId = optionalString(args, 'chatId') ?? ctx.chatId;
      const buffer = await readFile(path);
      if (buffer.length === 0) throw new Error(`cannot send empty file: ${path}`);
      const ext = extname(path).toLowerCase();

      if (IMAGE_EXTS.has(ext)) {
        // Images upload via im.v1.image.create and are sent as an image
        // message (the client can preview them inline).
        const up = await channel.rawClient.im.v1.image.create({
          data: { image_type: 'message', image: buffer },
        });
        const imageKey = up?.image_key;
        if (!imageKey) throw new Error('image upload returned no image_key');
        await channel.rawClient.im.v1.message.create({
          params: { receive_id_type: 'chat_id' },
          data: { receive_id: chatId, msg_type: 'image', content: JSON.stringify({ image_key: imageKey }) },
        });
        return { result: textResult(`sent image ${fileName} to ${chatId}`) };
      }

      // Non-image files upload via im.v1.file.create and are sent as a
      // 'file' message attachment.
      const up = await channel.rawClient.im.v1.file.create({
        data: { file_type: (FILE_TYPES[ext] ?? 'stream') as 'stream', file_name: fileName, file: buffer },
      });
      const fileKey = up?.file_key;
      if (!fileKey) throw new Error('file upload returned no file_key');
      await channel.rawClient.im.v1.message.create({
        params: { receive_id_type: 'chat_id' },
        data: { receive_id: chatId, msg_type: 'file', content: JSON.stringify({ file_key: fileKey }) },
      });
      return { result: textResult(`sent file ${fileName} to ${chatId}`) };
    },
  };
}

function recallMessageTool(channel: LarkChannel): AgentHostTool {
  return {
    definition: {
      name: 'feishu_recall_message',
      label: 'Recall a Feishu message',
      description:
        'Recall (withdraw) a Feishu message by message_id. Use this to clean up a message you just sent that was wrong, e.g. after feishu_send_message / feishu_reply_message. Only messages sent by the bot can be recalled.',
      parameters: objectSchema({
        messageId: { type: 'string', description: 'message_id of the message to recall.' },
      }, ['messageId']),
    },
    async execute(args) {
      const messageId = requiredString(args, 'messageId');
      await channel.rawClient.im.v1.message.delete({
        path: { message_id: messageId },
      });
      return { result: textResult(`recalled ${messageId}`) };
    },
  };
}

function feishuUriScheme(channel: LarkChannel, ctx: FeishuHostContext): AgentHostUriScheme {
  return {
    definition: {
      scheme: 'feishu',
      description: 'Read Feishu resources exposed by feishu-omp-bridge, e.g. feishu://message/<message_id> or feishu://current/context.',
      writable: false,
      immutable: false,
    },
    async handle(req) {
      if (req.operation !== 'read') {
        return { isError: true, error: 'feishu:// is read-only in this bridge', contentType: 'text/plain' };
      }
      const parsed = parseFeishuUri(req.url);
      if (parsed.kind === 'message') {
        const message = await fetchQuotedContext(channel, parsed.id);
        if (!message) return { isError: true, error: `message not found or inaccessible: ${parsed.id}`, contentType: 'text/plain' };
        return { content: JSON.stringify(message, null, 2), contentType: 'application/json' };
      }
      if (parsed.kind === 'context') {
        return { content: JSON.stringify(ctx, null, 2), contentType: 'application/json' };
      }
      return {
        isError: true,
        error: `unsupported feishu URI: ${req.url}. Supported: feishu://message/<message_id>, feishu://current/context`,
        contentType: 'text/plain',
      };
    },
  };
}

function parseFeishuUri(url: string): { kind: 'message'; id: string } | { kind: 'context' } | { kind: 'unknown' } {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return { kind: 'unknown' };
  }
  const host = parsed.hostname;
  const path = parsed.pathname.split('/').filter(Boolean);
  if (host === 'message' && path[0]) return { kind: 'message', id: decodeURIComponent(path[0]) };
  if (host === 'current' && path[0] === 'context') return { kind: 'context' };
  return { kind: 'unknown' };
}

function objectSchema(properties: Record<string, unknown>, required: string[] = []): Record<string, unknown> {
  return { type: 'object', properties, required, additionalProperties: false };
}

function requiredString(args: Record<string, unknown>, key: string): string {
  const value = args[key];
  if (typeof value !== 'string' || value.trim() === '') throw new Error(`${key} is required`);
  return value;
}

function optionalString(args: Record<string, unknown>, key: string): string | undefined {
  const value = args[key];
  return typeof value === 'string' && value.trim() ? value : undefined;
}

function textResult(text: string): { content: Array<{ type: 'text'; text: string }> } {
  return { content: [{ type: 'text', text }] };
}

function jsonResult(value: unknown): { content: Array<{ type: 'text'; text: string }> } {
  return textResult(JSON.stringify(value, null, 2));
}
