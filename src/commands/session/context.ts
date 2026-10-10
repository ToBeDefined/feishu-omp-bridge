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
import { workSessionName } from './display';

export const contextHandlers: Record<string, Handler> = {
  '/context': handleContext,
  '/ctx': handleContext,
};

/**
 * 给工作会话取样「最后一条用户消息」的段：当前段优先，没有当前段（/new 之后，
 * 新段还没落地）就退回最新段。用来做无名工作会话的标题回退。
 *
 * 代价与调用方约束：这里只挑一个 id，真正取消息要调 `loadSessionSummary`——它是
 * O(会话目录文件数) 的全目录扫描（会话文件可能数 MB）。所以**有 title 的调用方
 * 不该走到这里**（名字已在手上，扫目录纯属浪费），并且逐段回退被有意拒绝：历史段
 * 越多开销越大，只取这一个段。共享入口见 `resolveWorkSessionDisplay`。
 */
export function sampleSegmentId(active: WorkSession | undefined): string | undefined {
  if (!active) return undefined;
  return active.currentSegmentId ?? active.segments[active.segments.length - 1]?.sessionId;
}

export function collectContextInfo(
  ctx: CommandContext,
  summary: { lastMessage?: string; lastReply?: string } = {},
): ContextInfo {
  const scopeCwd = ctx.workspaces.cwdFor(ctx.scope) ?? homedir();
  const active = ctx.workSessions.activeWorkSession(ctx.scope);
  const globalMs = getRunIdleTimeoutMs(ctx.controls.cfg);
  // 身份 = 工作会话，不再是某个 OMP 会话：cwd 取工作会话的**当前段**（被 touch
  // 那一段），段数/目录数描述这摊活的规模，当前 OMP id 只在「当前段」里出现。
  const segments = active?.segments ?? [];
  const cwd = active?.cwd ?? scopeCwd;
  // 名字解析收敛到共享助手：title 优先（同步、零 IO），无名时用调用方已取到的
  // 取样段最后一条用户消息（handleContext 里由 sampleSegmentId 定位的那一段）。
  const name = workSessionName(ctx, active) ?? (summary.lastMessage?.trim() || undefined);
  const currentSegmentId = active?.currentSegmentId;
  const currentSegment =
    currentSegmentId !== undefined
      ? segments.find((s) => s.sessionId === currentSegmentId)
      : undefined;
  return {
    scope: ctx.scope,
    chatMode: ctx.chatMode,
    cwd,
    ...(active !== undefined ? { workSessionId: active.id } : {}),
    ...(name !== undefined ? { workSessionName: name } : {}),
    segmentCount: segments.length,
    cwdCount: new Set(segments.map((s) => s.cwd)).size,
    ...(currentSegmentId !== undefined ? { currentSessionId: currentSegmentId } : {}),
    ...(currentSegment !== undefined
      ? { currentSegmentLastActiveMs: currentSegment.lastActiveAtMs }
      : {}),
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
  // N 段 · M 个目录：只有工作会话真的跨了多个目录才标注。
  const multiDir =
    info.cwdCount > 1 ? ` _（${info.segmentCount} 段 · ${info.cwdCount} 个目录）_` : '';
  const workSessionLine =
    info.workSessionId !== undefined
      ? `\`${info.workSessionId}\` _（${info.segmentCount} 段）_`
      : '（无，下一条消息新建）';
  const currentSegmentLine =
    info.currentSessionId !== undefined
      ? `\`${info.currentSessionId}\`${
          info.currentSegmentLastActiveMs !== undefined
            ? ` _（最近活动 ${formatAgo(Date.now() - info.currentSegmentLastActiveMs)}）_`
            : ''
        }`
      : '（无，下一条消息新建）';
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
    `📁 **工作目录**: \`${cwd}\`${multiDir}`,
    `🧠 **工作会话**: ${workSessionLine}`,
    `🏷 **标题**: \`${info.workSessionName ?? '未命名'}\``,
    `🕒 **开始**: ${formatClockOr(info.createdAt, '（无，新工作会话）')}`,
    `🕘 **最后活动**: ${formatAgoOr(info.updatedAt, '（无，新工作会话）')}`,
    `🧵 **当前段**: ${currentSegmentLine}`,
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
  const active = ctx.workSessions.activeWorkSession(ctx.scope);
  const sampleId = sampleSegmentId(active);
  const summary =
    sampleId !== undefined
      ? await loadSessionSummary(ctx, sampleId)
      : { lastMessage: '', lastReply: '' };
  const card = contextCard(collectContextInfo(ctx, summary));
  await ctx.channel.send(ctx.msg.chatId, { card }, { replyTo: ctx.msg.messageId });
}
