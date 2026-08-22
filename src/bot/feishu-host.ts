import type { LarkChannel } from '@larksuiteoapi/node-sdk';
import { readFile, stat } from 'node:fs/promises';
import { basename, extname } from 'node:path';
import type { AgentHostTool, AgentHostUriScheme } from '../agent/types';
import { buildAgentCard } from '../card/agent-card';
import { sendManagedCard } from '../card/managed';
import type { ActiveRuns } from './active-runs';
import { fetchQuotedContext } from './quote';

export interface FeishuHostContext {
  scope: string;
  chatId: string;
  threadId?: string;
  replyToMessageId?: string;
  cwd: string;
  /** Needed by feishu_view_image to inject a local image into the active run. */
  activeRuns?: ActiveRuns;
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
      sendCardTool(channel, ctx),
      recallMessageTool(channel),
      viewImageTool(channel, ctx),
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
      // Feishu's upload ceiling is ~30MB; refuse earlier than OOM-ing on a
      // GB-sized path an agent could be tricked into sending.
      const st = await stat(path);
      if (st.size > 30 * 1024 * 1024) {
        throw new Error(`文件过大（${Math.round(st.size / 1024 / 1024)}MB），飞书上限约 30MB`);
      }
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

const IMAGE_MIME: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.bmp': 'image/bmp',
  '.tiff': 'image/tiff',
  '.ico': 'image/x-icon',
};

/**
 * Let the agent "look at" a local image by injecting it into the current
 * run as a follow-up with the image attached (OMP turns the path into a
 * base64 image payload). Only works while a run is active for this chat.
 */
function viewImageTool(channel: LarkChannel, ctx: FeishuHostContext): AgentHostTool {
  return {
    definition: {
      name: 'feishu_view_image',
      label: 'View a local image',
      description:
        'Inject a local image file into the current conversation so the model can actually see it. Use this when you need to analyze a screenshot, diagram, or any image on disk (e.g. one you just generated or one the user sent that was cached). Only works during an active run.',
      parameters: objectSchema({
        path: { type: 'string', description: 'Local filesystem path to an image file.' },
        note: { type: 'string', description: 'Optional instruction describing what to look for in the image.' },
      }, ['path']),
    },
    async execute(args) {
      const path = requiredString(args, 'path');
      const note = optionalString(args, 'note');
      const ext = extname(path).toLowerCase();
      if (!IMAGE_MIME[ext]) {
        throw new Error(`not an image file (supported: png/jpg/gif/webp/bmp/tiff/ico): ${path}`);
      }
      await stat(path); // verify readable without reading the whole image
      const activeRuns = ctx.activeRuns;
      if (!activeRuns || !activeRuns.has(ctx.scope)) {
        throw new Error('no active run for this chat; cannot inject an image');
      }
      const message = note ? `查看图片 ${path}（注意：${note}）` : `查看图片 ${path}`;
      const ok = await activeRuns.submitPrompt(ctx.scope, 'follow_up' as const, message, [path]);
      if (!ok) throw new Error('failed to inject image into the active run');
      return { result: textResult(`已注入图片 ${path} 供查看`) };
    },
  };
}

function sendCardTool(channel: LarkChannel, ctx: FeishuHostContext): AgentHostTool {
  return {
    definition: {
      name: 'feishu_send_card',
      label: 'Send Feishu interactive card',
      description:
        'Send an interactive card with buttons to the current Feishu chat (or as a reply to a message_id). When the user clicks a button, the button value is delivered back to this conversation as a card-click. Use for confirmations, choices, and structured input.',
      parameters: objectSchema({
        title: { type: 'string', description: 'Card summary / title.' },
        text: { type: 'string', description: 'Markdown body shown on the card.' },
        buttons: {
          type: 'array',
          description: 'Buttons to show; each needs label (string) and value (object). First button renders primary.',
          items: {
            type: 'object',
            properties: {
              label: { type: 'string' },
              value: { type: 'object' },
            },
            required: ['label', 'value'],
          },
        },
        replyTo: { type: 'string', description: 'Optional message_id to reply to. Defaults to the triggering message.' },
      }, ['title', 'text', 'buttons']),
    },
    async execute(args) {
      const title = requiredString(args, 'title');
      const text = requiredString(args, 'text');
      const replyTo = optionalString(args, 'replyTo') ?? ctx.replyToMessageId;
      const card = buildAgentCard(title, text, args['buttons']);
      const { messageId } = await sendManagedCard(channel, ctx.chatId, card, replyTo);
      return { result: jsonResult({ messageId }) };
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
