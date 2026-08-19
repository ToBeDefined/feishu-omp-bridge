import { homedir } from 'node:os';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { paths } from '../../config/paths';
import {
  getOmpModel,
  getOmpThinking,
  getRunIdleTimeoutMs,
} from '../../config/schema';
import type { CommandContext, Handler } from '../index';
import { reply } from '../shared';
import { summarizeMd } from '../shared';

export const contextHandlers: Record<string, Handler> = {
  '/context': handleContext,
  '/ctx': handleContext,
};

function formatLastSeen(ts: number | undefined): string {
  if (!ts) return '（无，新会话）';
  const ms = Date.now() - ts;
  if (ms < 60_000) return '刚刚';
  if (ms < 3_600_000) return `${Math.floor(ms / 60_000)} 分钟前`;
  if (ms < 86_400_000) return `${Math.floor(ms / 3_600_000)} 小时前`;
  return `${Math.floor(ms / 86_400_000)} 天前`;
}

function formatClock(ts: number | undefined): string {
  if (!ts) return '（无，新会话）';
  const d = new Date(ts);
  const today = new Date();
  const sameDay = d.toDateString() === today.toDateString();
  const hhmm = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  return sameDay ? `今天 ${hhmm}` : `${d.getMonth() + 1}月${d.getDate()}日 ${hhmm}`;
}

export function renderContext(
  ctx: CommandContext,
  summary: { lastMessage?: string; lastReply?: string } = {},
): string {
  const cwd = ctx.workspaces.cwdFor(ctx.scope) ?? homedir();
  const sess = ctx.sessions.getRaw(ctx.scope);
  const scopeMinutes = ctx.sessions.getIdleTimeoutMinutes(ctx.scope);
  const globalMs = getRunIdleTimeoutMs(ctx.controls.cfg);
  const globalMinutes = globalMs ? Math.round(globalMs / 60_000) : 0;
  const model = getOmpModel(ctx.controls.cfg);
  const thinking = getOmpThinking(ctx.controls.cfg);
  const running = ctx.activeRuns.has(ctx.scope);
  const scopeLine =
    ctx.chatMode === 'topic' ? `\`${ctx.scope}\`（话题独立会话）` : `\`${ctx.scope}\``;
  const sessionLine = sess?.sessionId ? `\`${sess.sessionId}\`` : '（无，下条消息新建）';
  const runningLine = running ? '有任务正在执行' : '空闲，等待指令';
  const modelLine = model ? `\`${model}\`` : '跟随 OMP 默认';
  const thinkingLine = thinking ? `\`${thinking}\`` : '跟随 OMP 默认';
  const idleLine =
    scopeMinutes !== undefined
      ? scopeMinutes > 0
        ? `本会话 ${scopeMinutes} 分钟`
        : '本会话已关闭'
      : globalMinutes > 0
        ? `全局 ${globalMinutes} 分钟`
        : '未启用（不自动中断任务）';
  // Only surface a quick-dir when one of the named workspaces points at the
  // current cwd; otherwise say none exists.
  const matchingNames = Object.entries(ctx.workspaces.listNamed())
    .filter(([, path]) => path === cwd)
    .map(([name]) => `\`${name}\``);
  const wsLine =
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
    `🧠 **会话 ID**: ${sessionLine}`,
    sess?.title ? `🏷 **标题**: \`${sess.title}\`` : '',
    `🕒 **开始对话**: ${formatClock(sess?.createdAt)}`,
    `🕘 **最后对话**: ${formatLastSeen(sess?.updatedAt)}`,
    lastMsgLine,
    lastReplyLine,
    `⚙️ **任务状态**: ${runningLine}`,
    `🤖 **当前模型**: ${modelLine}`,
    `💭 **思考强度**: ${thinkingLine}`,
    `⏱ **空闲超时**: ${idleLine}`,
    `📂 **快捷目录**: ${wsLine}`,
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
}

/** Parse one session JSONL file: leading session frame + last non-empty
 * assistant reply + last real user input. */
export function scanSessionFile(text: string): SessionScan {
  let meta: SessionMeta | undefined;
  let lastAssistant = '';
  let lastUserMessage = '';
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
        if (real) lastUserMessage = real;
      }
    } catch {
      /* skip malformed */
    }
  }
  return { meta, lastAssistant, lastUserMessage };
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
  sessionId: string,
): Promise<{ lastMessage: string; lastReply: string }> {
  try {
    const entries = await readdir(paths.ompSessionsDir);
    for (const name of entries) {
      if (!name.endsWith('.jsonl')) continue;
      const text = await readFile(join(paths.ompSessionsDir, name), 'utf8');
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
  const sess = ctx.sessions.getRaw(ctx.scope);
  let summary = { lastMessage: '', lastReply: '' };
  if (sess?.sessionId) {
    summary = await loadSessionSummary(sess.sessionId);
  }
  await reply(ctx, renderContext(ctx, summary));
}
