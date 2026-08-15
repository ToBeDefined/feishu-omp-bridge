import { readdir, readFile, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { paths } from '../config/paths';
import {
  getOmpModel,
  getOmpThinking,
  getRunIdleTimeoutMs,
} from '../config/schema';
import { forgetManagedCard, sendManagedCard, updateManagedCard } from '../card/managed';
import {
  resumeCard,
  resumeCancelledCard,
  resumeSavedCard,
  type ResumeOption,
} from '../card/model-card';
import { statusCard, workspacesCard } from '../card/templates';
import type { CommandContext, Handler } from './index';
import { expandTilde, FORM_SETTLE_MS, recallMessage, reply } from './shared';
import { createBoundChat, defaultChatName } from '../bot/group';
import { log } from '../core/logger';

export const sessionHandlers: Record<string, Handler> = {
  '/new': handleNew,
  '/reset': handleNew,
  '/cd': handleCd,
  '/ws': handleWs,
  '/status': handleStatus,
  '/timeout': handleTimeout,
  '/context': handleContext,
  '/resume': handleResume,
};

async function handleNew(args: string, ctx: CommandContext): Promise<void> {
  const trimmed = args.trim();

  // /new chat [name]  — spin up a fresh group chat bound to a fresh session
  if (trimmed === 'chat' || trimmed.startsWith('chat ')) {
    const rawName = trimmed === 'chat' ? '' : trimmed.slice(5).trim();
    return handleNewChat(rawName, ctx);
  }

  const wasRunning = ctx.activeRuns.interrupt(ctx.scope);
  ctx.sessions.clear(ctx.scope);
  const ack = wasRunning ? '已中断当前任务并开始新会话。' : '已开始新会话。';
  await reply(ctx, `${ack}\n\n${renderContext(ctx)}`);
}

async function handleNewChat(rawName: string, ctx: CommandContext): Promise<void> {
  const sourceCwd = ctx.workspaces.cwdFor(ctx.scope);
  const name = rawName || defaultChatName();

  let created;
  try {
    created = await createBoundChat({
      channel: ctx.channel,
      name,
      inviteOpenId: ctx.msg.senderId,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    await reply(ctx, `❌ 创建群失败：${msg}\n\n确认 bot 已开启 \`im:chat\` 权限。`);
    return;
  }

  // Inherit cwd from the originating chat so the new group starts in the
  // same workspace; otherwise it'll fall back to $HOME.
  if (sourceCwd) {
    ctx.workspaces.setCwd(created.chatId, sourceCwd);
  }

  // Welcome the user inside the new group with a hint about how to start.
  const welcome = sourceCwd
    ? `🎉 群已建好，cwd 继承自原群：\`${sourceCwd}\`\n\n@我 + 任意消息开始对话。`
    : '🎉 群已建好。\n\n@我 + 任意消息开始对话。';
  try {
    await ctx.channel.send(created.chatId, { markdown: welcome });
  } catch (err) {
    console.warn('[new-chat] welcome message failed:', err);
  }

  await reply(
    ctx,
    `✓ 已创建群 **${created.name}**，去新群里继续。`,
  );
}

async function handleCd(args: string, ctx: CommandContext): Promise<void> {
  const input = args.trim();
  if (!input) {
    await reply(ctx, '用法：`/cd <绝对路径>` 或 `/cd ~/xxx`');
    return;
  }
  if (!input.startsWith('/') && !input.startsWith('~')) {
    await reply(ctx, '请使用绝对路径，或 `~/xxx` 表示 home 下的子路径。');
    return;
  }
  const absolute = expandTilde(input);
  try {
    const st = await stat(absolute);
    if (!st.isDirectory()) {
      await reply(ctx, `路径不是目录：\`${absolute}\``);
      return;
    }
  } catch {
    await reply(ctx, `路径不存在：\`${absolute}\``);
    return;
  }
  ctx.activeRuns.interrupt(ctx.scope);
  ctx.workspaces.setCwd(ctx.scope, absolute);
  ctx.sessions.clear(ctx.scope);
  await reply(ctx, `✓ 已切换 cwd 到 \`${absolute}\`\n（session 已重置）`);
}

async function handleWs(args: string, ctx: CommandContext): Promise<void> {
  const parts = args.trim().split(/\s+/);
  const sub = parts[0] ?? '';
  const name = parts.slice(1).join(' ').trim();
  switch (sub) {
    case '':
    case 'list':
      return handleWsList(ctx);
    case 'save':
      return handleWsSave(name, ctx);
    case 'use':
      return handleWsUse(name, ctx);
    case 'remove':
    case 'rm':
      return handleWsRemove(name, ctx);
    default:
      await reply(ctx, '用法：`/ws [list|save <name>|use <name>|remove <name>]`');
  }
}

async function handleWsList(ctx: CommandContext): Promise<void> {
  const named = ctx.workspaces.listNamed();
  const currentCwd = ctx.workspaces.cwdFor(ctx.scope);
  const card = workspacesCard(currentCwd, named);
  await ctx.channel.send(ctx.msg.chatId, { card }, { replyTo: ctx.msg.messageId });
}

async function handleWsSave(name: string, ctx: CommandContext): Promise<void> {
  if (!name) {
    await reply(ctx, '用法：`/ws save <name>`');
    return;
  }
  const cwd = ctx.workspaces.cwdFor(ctx.scope);
  if (!cwd) {
    await reply(ctx, '当前 chat 未设置 cwd，先用 `/cd` 设置再保存。');
    return;
  }
  ctx.workspaces.saveNamed(name, cwd);
  await reply(ctx, `✓ 工作空间已保存：\`${name}\` → ${cwd}`);
}

async function handleWsUse(name: string, ctx: CommandContext): Promise<void> {
  if (!name) {
    await reply(ctx, '用法：`/ws use <name>`');
    return;
  }
  const cwd = ctx.workspaces.getNamed(name);
  if (!cwd) {
    await reply(ctx, `未找到工作空间：\`${name}\``);
    return;
  }
  ctx.activeRuns.interrupt(ctx.scope);
  ctx.workspaces.setCwd(ctx.scope, cwd);
  ctx.sessions.clear(ctx.scope);
  await reply(ctx, `✓ 已切换到 \`${name}\` (${cwd})\n（session 已重置）`);
}

async function handleWsRemove(name: string, ctx: CommandContext): Promise<void> {
  if (!name) {
    await reply(ctx, '用法：`/ws remove <name>`');
    return;
  }
  if (!ctx.workspaces.removeNamed(name)) {
    await reply(ctx, `未找到工作空间：\`${name}\``);
    return;
  }
  await reply(ctx, `✓ 已删除工作空间：\`${name}\``);
}

async function handleStatus(_args: string, ctx: CommandContext): Promise<void> {
  const cwd = ctx.workspaces.cwdFor(ctx.scope) ?? homedir();
  const sess = ctx.sessions.getRaw(ctx.scope);
  const card = statusCard({
    cwd,
    sessionId: sess?.sessionId,
    sessionStale: Boolean(sess && sess.cwd !== cwd),
    agentName: ctx.agent.displayName,
    scope: ctx.scope,
    chatMode: ctx.chatMode,
  });
  await ctx.channel.send(ctx.msg.chatId, { card }, { replyTo: ctx.msg.messageId });
}

async function handleTimeout(args: string, ctx: CommandContext): Promise<void> {
  const trimmed = args.trim().toLowerCase();
  const globalMs = getRunIdleTimeoutMs(ctx.controls.cfg);
  const globalMinutes = globalMs ? Math.round(globalMs / 60_000) : 0;
  const formatGlobal = (): string =>
    globalMinutes > 0 ? `${globalMinutes} 分钟` : '未启用';

  // /timeout — show effective value + source
  if (!trimmed) {
    const scopeMinutes = ctx.sessions.getIdleTimeoutMinutes(ctx.scope);
    const usage =
      '\n\n用法:\n- `/timeout 15` 当前 session 设 15 分钟\n- `/timeout off` 当前 session 关闭探活\n- `/timeout default` 清除 session 覆盖,回退全局\n\n_注:`/new` 会清掉当前 session 的覆盖,回到全局_';
    if (scopeMinutes !== undefined) {
      const effective =
        scopeMinutes > 0 ? `${scopeMinutes} 分钟` : '已关闭（当前 session）';
      await reply(ctx, `⏱ 当前 session 探活:${effective}\n全局默认:${formatGlobal()}${usage}`);
      return;
    }
    await reply(ctx, `⏱ 当前 session 探活:跟随全局(${formatGlobal()})${usage}`);
    return;
  }

  if (trimmed === 'default') {
    const cleared = ctx.sessions.clearIdleTimeoutOverride(ctx.scope);
    log.info('command', 'timeout-clear', { scope: ctx.scope, cleared });
    await reply(
      ctx,
      cleared
        ? `✅ 已清除 session 覆盖,回退到全局(${formatGlobal()})。`
        : `当前 session 本来就没设过覆盖,跟随全局(${formatGlobal()})。`,
    );
    return;
  }

  if (trimmed === 'off' || trimmed === '0') {
    ctx.sessions.setIdleTimeoutMinutes(ctx.scope, 0);
    log.info('command', 'timeout-off', { scope: ctx.scope });
    await reply(ctx, '✅ 已关闭当前 session 的探活。');
    return;
  }

  const n = Number.parseInt(trimmed, 10);
  if (!Number.isFinite(n) || n < 1 || n > 120) {
    await reply(ctx, '❌ 用法:`/timeout <1-120>` / `/timeout off` / `/timeout default`');
    return;
  }
  ctx.sessions.setIdleTimeoutMinutes(ctx.scope, n);
  log.info('command', 'timeout-set', { scope: ctx.scope, minutes: n });
  await reply(ctx, `✅ 当前 session 探活已设为 ${n} 分钟。`);
}

function formatLastSeen(ts: number | undefined): string {
  if (!ts) return '（无，新会话）';
  const ms = Date.now() - ts;
  if (ms < 60_000) return '刚刚';
  if (ms < 3_600_000) return `${Math.floor(ms / 60_000)} 分钟前`;
  if (ms < 86_400_000) return `${Math.floor(ms / 3_600_000)} 小时前`;
  return `${Math.floor(ms / 86_400_000)} 天前`;
}

/** Compact text for a one-line display: collapse whitespace, cap length. */
function summarize(text: string): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > 48 ? `${flat.slice(0, 48)}…` : flat;
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
  const named = Object.keys(ctx.workspaces.listNamed());
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
  const wsLine =
    named.length > 0 ? named.map((n) => `\`${n}\``).join(' ') : '（无）';
  const lastMsgLine = summary.lastMessage
    ? `💬 **最后消息**: ${summarize(summary.lastMessage)}`
    : '';
  const lastReplyLine = summary.lastReply
    ? `📝 **最后回复**: ${summarize(summary.lastReply)}`
    : '';
  const lines = [
    `💬 **聊天窗口**: ${scopeLine}`,
    `📁 **工作目录**: \`${cwd}\``,
    `🧠 **会话 ID**: ${sessionLine}`,
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

async function handleContext(_args: string, ctx: CommandContext): Promise<void> {
  const sess = ctx.sessions.getRaw(ctx.scope);
  let summary = { lastMessage: '', lastReply: '' };
  if (sess?.sessionId) {
    summary = await loadSessionSummary(sess.sessionId);
  }
  await reply(ctx, renderContext(ctx, summary));
}

interface SessionMeta {
  id?: string;
  cwd?: string;
  timestamp?: string;
}

const RESUME_PAGE_SIZE = 5;

/**
 * Scan the bridge's OMP session dir for `.jsonl` session files. For each:
 *  - read the leading `type:"session"` frame for id / cwd / timestamp, and
 *  - take the LAST non-empty assistant text reply as a short "what this
 *    conversation was about" description (assistant's final reply usually
 *    summarizes the topic). Newest sessions first.
 *
 * Reading whole files is acceptable here: /resume is a low-frequency,
 * operator-only command, and correctness of the description matters more
 * than shaving a few ms off a 6MB log.
 */
/**
 * Extract the real user input from a user-message frame. Each user frame
 * carries the full system prompt ("运行约定") plus a `<bridge_context>` block
 * injected by the bridge; the actual user text sits AFTER the LAST
 * `</bridge_context>`. Returns empty for system-prompt-only frames.
 */
function extractUserInput(text: string): string {
  if (!text) return '';
  const idx = text.lastIndexOf('</bridge_context>');
  const body = idx >= 0 ? text.slice(idx + '</bridge_context>'.length).trim() : text.trim();
  if (!body) return '';
  // A frame that is ONLY the system prompt has nothing after the bridge
  // context. If what's left still looks like prompt boilerplate, drop it.
  if (body.startsWith('运行约定') || body.includes('你正在 feishu-omp-bridge 里运行')) return '';
  return body;
}

interface SessionScan {
  meta?: SessionMeta;
  lastAssistant: string;
  lastUserMessage: string;
}

/** Parse one session JSONL file: leading session frame + last non-empty
 * assistant reply + last real user input. */
function scanSessionFile(text: string): SessionScan {
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

/** Load the last message / last reply for the given session id, by scanning
 * the matching session file. Empty strings when not found. */
async function loadSessionSummary(sessionId: string): Promise<{ lastMessage: string; lastReply: string }> {
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

async function listResumableSessions(): Promise<ResumeOption[]> {
  const dir = paths.ompSessionsDir;
  const out: ResumeOption[] = [];
  try {
    const entries = await readdir(dir);
    for (const name of entries) {
      if (!name.endsWith('.jsonl')) continue;
      try {
        const text = await readFile(join(dir, name), 'utf8');
        const { meta, lastAssistant, lastUserMessage } = scanSessionFile(text);
        if (!meta?.id || !meta.cwd) continue;
        out.push({
          sessionId: meta.id,
          cwd: meta.cwd,
          timestamp: meta.timestamp ?? name,
          summary: lastAssistant,
          lastMessage: lastUserMessage,
        });
      } catch {
        continue;
      }
    }
  } catch {
    return [];
  }
  out.sort((a, b) => b.timestamp.localeCompare(a.timestamp));
  return out;
}

async function handleResume(args: string, ctx: CommandContext): Promise<void> {
  const [sub, ...rest] = args.trim().split(/\s+/);

  if (sub === 'use') {
    const sessionId = rest.join('');
    const sessions = await listResumableSessions();
    const match = sessions.find((s) => s.sessionId === sessionId);
    if (!match) {
      await reply(ctx, `❌ 未找到会话 \`${sessionId}\`。`);
      return;
    }
    await applyResume(ctx, match);
    return;
  }

  if (sub === 'more' || sub === 'back') {
    const offset = Number.parseInt(rest.join(''), 10);
    if (!Number.isFinite(offset) || offset < 0) {
      await reply(ctx, '❌ 无效的分页偏移。');
      return;
    }
    await showResumePage(ctx, offset);
    return;
  }

  if (sub === 'cancel') {
    if (ctx.fromCardAction) {
      const msgId = ctx.msg.messageId;
      void (async () => {
        await new Promise((r) => setTimeout(r, FORM_SETTLE_MS));
        await updateManagedCard(ctx.channel, msgId, resumeCancelledCard()).catch(() => {});
        forgetManagedCard(msgId);
      })();
    }
    return;
  }

  if (!sub) {
    await showResumePage(ctx, 0);
    return;
  }

  // Direct resume by id prefix: find the session anywhere in history.
  const sessions = await listResumableSessions();
  const match = sessions.find((s) => s.sessionId.startsWith(sub));
  if (!match) {
    await reply(ctx, `❌ 未找到会话 \`${sub}\`。发 \`/resume\` 查看可恢复的会话列表。`);
    return;
  }
  await applyResume(ctx, match);
}

async function showResumePage(ctx: CommandContext, offset: number): Promise<void> {
  const sessions = await listResumableSessions();
  if (sessions.length === 0) {
    await reply(ctx, '没有找到可恢复的历史会话。');
    return;
  }
  const page = sessions.slice(offset, offset + RESUME_PAGE_SIZE);
  const currentId = ctx.sessions.getRaw(ctx.scope)?.sessionId;
  if (ctx.fromCardAction) await recallMessage(ctx, ctx.msg.messageId);
  await sendManagedCard(
    ctx.channel,
    ctx.msg.chatId,
    resumeCard(currentId, page, { offset, total: sessions.length }),
  );
}

async function applyResume(ctx: CommandContext, match: ResumeOption): Promise<void> {
  const currentId = ctx.sessions.getRaw(ctx.scope)?.sessionId;
  if (currentId && match.sessionId === currentId) {
    log.info('command', 'resume-already-current', { scope: ctx.scope, sessionId: match.sessionId });
    const summary = await loadSessionSummary(match.sessionId);
    if (ctx.fromCardAction) {
      const msgId = ctx.msg.messageId;
      void (async () => {
        await new Promise((r) => setTimeout(r, FORM_SETTLE_MS));
        await updateManagedCard(
          ctx.channel,
          msgId,
          resumeSavedCard(match.sessionId, match.cwd, renderContext(ctx, summary)),
        ).catch(() => {});
        forgetManagedCard(msgId);
      })();
    } else {
      void reply(ctx, `这个会话已经是当前会话。\n\n---\n\n${renderContext(ctx, summary)}`);
    }
    return;
  }
  const cwd = match.cwd || homedir();
  // Interrupt any active run, then re-point this chat's session + cwd at
  // the historical session. resumeFor(scope, cwd) will match next run.
  ctx.activeRuns.interrupt(ctx.scope);
  ctx.workspaces.setCwd(ctx.scope, cwd);
  ctx.sessions.set(ctx.scope, match.sessionId, cwd);
  log.info('command', 'resume', {
    scope: ctx.scope,
    sessionId: match.sessionId,
    cwd,
  });
  const summary = await loadSessionSummary(match.sessionId);
  if (ctx.fromCardAction) {
    const msgId = ctx.msg.messageId;
    void (async () => {
      await new Promise((r) => setTimeout(r, FORM_SETTLE_MS));
      await updateManagedCard(
        ctx.channel,
        msgId,
        resumeSavedCard(match.sessionId, cwd, renderContext(ctx, summary)),
      ).catch(() => {});
      forgetManagedCard(msgId);
    })();
  } else {
    void reply(
      ctx,
      `✅ 已恢复会话 \`${match.sessionId.slice(0, 8)}…\`\n📁 cwd: \`${cwd}\`\n\n下一条消息从该会话继续。\n\n---\n\n${renderContext(ctx, summary)}`,
    );
  }
}
