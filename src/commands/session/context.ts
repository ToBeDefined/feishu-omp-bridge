import { homedir } from 'node:os';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  getOmpModel,
  getOmpSessionDir,
  getOmpThinking,
  getRunIdleTimeoutMs,
} from '../../config/schema';
import type { CommandContext, Handler } from '../index';
import { formatIdleLine } from '../shared';
import { summarizeMd } from '../../utils/text';
import { contextCard, type ContextInfo } from '../../card/templates';
import { formatAgo, formatAgoOr, formatClockOr } from '../../utils/time';
import type { WorkSession } from '../../session/work-session';
import { sessionName } from './display';
import { conversationCwd } from '../../session/current-cwd';

export const contextHandlers: Record<string, Handler> = {
  '/context': handleContext,
  '/ctx': handleContext,
};

export function collectContextInfo(
  ctx: CommandContext,
  summary: { lastMessage?: string; lastReply?: string } = {},
): ContextInfo {
  const active = ctx.workSessions.activeWorkSession(ctx.scope);
  const globalMs = getRunIdleTimeoutMs(ctx.controls.cfg);
  // 身份 = 会话（一个 OMP 会话 = 一个对话）：cwd 取它自己的目录（会话优先，聊天
  // 窗口的 cwd 只是它没有会话时的落点），名字取 /rename 的 title，没有就回退到它
  // 最后一条用户消息（调用方已取到的 summary）。
  const cwd = conversationCwd(ctx.workspaces, ctx.workSessions, ctx.scope);
  const sessionId = active?.currentSegmentId;
  // 名字 = 真标题（/rename 起的）。**不拿最后一条用户消息冒充标题**：那会让
  // 「标题」这一行看起来像用户起的名，实际只是他上一句话。
  const name = sessionName(active);
  return {
    scope: ctx.scope,
    chatMode: ctx.chatMode,
    cwd,
    ...(sessionId !== undefined ? { sessionId } : {}),
    ...(name !== undefined ? { sessionName: name } : {}),
    createdAt: active?.createdAtMs,
    updatedAt: active?.lastActiveAtMs,
    running: ctx.activeRuns.has(ctx.scope),
    model: getOmpModel(ctx.controls.cfg),
    thinking: getOmpThinking(ctx.controls.cfg),
    idleLine: formatIdleLine(
      ctx.workSessions.getIdleTimeoutMinutes(ctx.scope),
      globalMs ? Math.round(globalMs / 60_000) : 0,
    ),
    wsNames: Object.entries(ctx.workspaces.listNamed())
      .filter(([, path]) => path === cwd)
      .map(([name]) => name),
    summary,
  };
}

export function renderContext(
  ctx: CommandContext,
  summary: { lastMessage?: string; lastReply?: string } = {},
): string {
  const info = collectContextInfo(ctx, summary);
  const cwd = info.cwd;
  const running = info.running;
  const scopeLine =
    ctx.chatMode === 'topic' ? `\`${ctx.scope}\`（话题独立会话）` : `\`${ctx.scope}\``;
  const sessionLine =
    info.sessionId !== undefined ? `\`${info.sessionId}\`` : '（无，下一条消息新建）';
  const runningLine = running ? '有任务正在执行' : '空闲，等待指令';
  const modelLine = info.model ? `\`${info.model}\`` : '跟随 OMP 默认';
  const thinkingLine = info.thinking ? `\`${info.thinking}\`` : '跟随 OMP 默认';
  const idleLine = info.idleLine;
  // Only surface a quick-dir when one of the named workspaces points at the
  // current cwd; otherwise say none exists.
  const matchingNames = Object.entries(ctx.workspaces.listNamed())
    .filter(([, path]) => path === cwd)
    .map(([name]) => `\`${name}\``);
  const quickDirLine =
    matchingNames.length > 0 ? matchingNames.join(' ') : '（当前目录无快捷方式）';
  const lastMsgLine = summary.lastMessage
    ? `💬 **最后消息**: ${summarizeMd(summary.lastMessage)}`
    : '';
  const lastReplyLine = summary.lastReply
    ? `📝 **最后回复**: ${summarizeMd(summary.lastReply)}`
    : '';
  const lines = [
    `💬 **聊天窗口**: ${scopeLine}`,
    `📁 **工作目录**: \`${cwd}\``,
    `🧠 **会话**: ${sessionLine}`,
    info.sessionName ? `🏷 **标题**: \`${info.sessionName}\`` : '',
    `🕒 **开始**: ${formatClockOr(info.createdAt, '（无，新会话）')}`,
    `🕘 **最后活动**: ${formatAgoOr(info.updatedAt, '（无，新会话）')}`,
    lastMsgLine,
    lastReplyLine,
    `⚙️ **任务状态**: ${runningLine}`,
    `🤖 **当前模型**: ${modelLine}`,
    `💭 **思考强度**: ${thinkingLine}`,
    `⏱ **空闲超时**: ${idleLine}`,
    `📂 **快捷目录**: ${quickDirLine}`,
  ];
  return lines.filter(Boolean).join('\n');
}

interface SessionMeta {
  id?: string;
  cwd?: string;
  timestamp?: string;
}

export interface SessionScan {
  meta?: SessionMeta;
  lastAssistant: string;
  lastUserMessage: string;
  /** Real user turns (bridge_context stripped) — the /history row's 「N 轮」. */
  turns: number;
}

/** Parse one session JSONL file: leading session frame + last non-empty
 * assistant reply + last real user input. */
export function scanSessionFile(text: string): SessionScan {
  let meta: SessionMeta | undefined;
  let lastAssistant = '';
  let lastUserMessage = '';
  let turns = 0;
  for (const line of text.split('\n')) {
    if (!meta && line.includes('"type":"session"')) {
      try {
        meta = JSON.parse(line) as SessionMeta;
      } catch {
        /* skip malformed */
      }
      continue;
    }
    if (!line.includes('"type":"message"')) continue;
    try {
      const frame = JSON.parse(line) as {
        message?: { role?: string; content?: Array<{ type?: string; text?: string }> };
      };
      const msg = frame.message;
      if (!msg?.role) continue;
      const textPart = (msg.content ?? [])
        .filter((c) => c.type === 'text' && c.text)
        .map((c) => c.text ?? '')
        .join('');
      if (msg.role === 'assistant') {
        if (textPart.trim()) lastAssistant = textPart.trim();
      } else if (msg.role === 'user') {
        const real = extractUserInput(textPart);
        if (real) {
          lastUserMessage = real;
          turns += 1;
        }
      }
    } catch {
      /* skip malformed */
    }
  }
  return { meta, lastAssistant, lastUserMessage, turns };
}

export function extractUserInput(text: string): string {
  if (!text) return '';
  const idx = text.lastIndexOf('</bridge_context>');
  const body = idx >= 0 ? text.slice(idx + '</bridge_context>'.length).trim() : text.trim();
  if (!body) return '';
  if (body.startsWith('运行约定') || body.includes('你正在 feishu-omp-bridge 里运行')) return '';
  // Strip <quoted_message> blocks: when the user replies with a quote,
  // bridge injects the referenced content BEFORE their actual input. The
  // quoted content isn't user input — showing it as "最后消息" is noise
  // (and leaks the raw XML tags into summaries).
  const cleaned = body
    .replace(/<quoted_message\b[^>]*>[\s\S]*?<\/quoted_message>/g, '')
    .trim();
  return cleaned;
}
export async function loadSessionSummary(
  ctx: CommandContext,
  sessionId: string,
): Promise<{ lastMessage: string; lastReply: string }> {
  try {
    const dir = getOmpSessionDir(ctx.controls.cfg);
    const entries = await readdir(dir);
    for (const name of entries) {
      if (!name.endsWith('.jsonl')) continue;
      const text = await readFile(join(dir, name), 'utf8');
      // Cheap prefilter before the full line-by-line parse: session files can
      // be many MB and this loop scans ALL of them on every /ctx.
      if (!text.includes(`"id":"${sessionId}"`)) continue;
      const scan = scanSessionFile(text);
      if (scan.meta?.id === sessionId) {
        return { lastMessage: scan.lastUserMessage, lastReply: scan.lastAssistant };
      }
    }
  } catch {
    /* fall through to empty */
  }
  return { lastMessage: '', lastReply: '' };
}

async function handleContext(_args: string, ctx: CommandContext): Promise<void> {
  const sessionId = ctx.workSessions.activeWorkSession(ctx.scope)?.currentSegmentId;
  const summary =
    sessionId !== undefined
      ? await loadSessionSummary(ctx, sessionId)
      : { lastMessage: '', lastReply: '' };
  const card = contextCard(collectContextInfo(ctx, summary));
  await ctx.channel.send(ctx.msg.chatId, { card }, { replyTo: ctx.msg.messageId });
}
