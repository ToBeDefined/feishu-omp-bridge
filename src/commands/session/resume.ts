import { homedir } from 'node:os';
import { stat } from 'node:fs/promises';
import { forgetManagedCard, updateManagedCard } from '../../card/managed';
import { resumeSavedCard, type ResumeOption } from '../../card/model-card';
import type { CommandContext, Handler } from '../index';
import { FORM_SETTLE_MS, reply } from '../shared';
import { renderContext, loadSessionSummary } from './context';
import { scanSessionFiles } from './sessions';
import { log } from '../../core/logger';

/**
 * `/resume` / `/session` —— **带参数**时才走到这里：`/resume <会话 id|前缀>` 直接恢复。
 * 不带参数时由 `session/index.ts` 转发给 `/history`（两者的清单卡片曾是重复能力，
 * 选择器卡片连同分页 / 取消 / 按钮分支一并下线）。
 */
export const resumeHandlers: Record<string, Handler> = {
  '/resume': handleResume,
  '/session': handleResume,
};

/**
 * 若另一个 scope 的**当前会话**落在给定会话集合里，返回那个 scope。
 *
 * 一个对话只应由一个 chat 恢复：同一 JSONL 被两个 OMP 进程 `--resume` 会让两边的
 * 回合交错写进同一个文件。
 */
function otherScopeHolding(ctx: CommandContext, sessionId: string): string | undefined {
  for (const scope of ctx.sessions.chats()) {
    if (scope === ctx.scope) continue;
    if (ctx.sessions.sessionFor(scope)?.sessionId === sessionId) return scope;
  }
  return undefined;
}

export async function listResumableSessions(ctx: CommandContext): Promise<ResumeOption[]> {
  // 一行 = 一个会话（一个 OMP 会话 = 一个对话），按最后活动倒序；被别的 scope
  // 当前绑着的那些不列（同一 JSONL 不能两边同时 --resume）。
  const files = await scanSessionFiles(ctx);
  return files
    .filter((f) => otherScopeHolding(ctx, f.sessionId) === undefined)
    .map((f) => ({
      sessionId: f.sessionId,
      cwd: f.cwd,
      timestamp: f.startedAt,
      updatedAtMs: f.updatedAtMs,
      ...(f.title !== undefined ? { title: f.title } : {}),
      summary: f.lastMessage ?? f.summary ?? '',
    }));
}

async function handleResume(args: string, ctx: CommandContext): Promise<void> {
  const target = args.trim();
  if (!target) {
    // 正常路径由 session/index.ts 转发给 /history；直接调用 handler 时给用法，
    // 绝不能落进下面的前缀匹配（空前缀会匹配到任意一条会话）。
    await reply(ctx, '用法：`/resume <会话 id>`；不带参数时等同 `/history`。');
    return;
  }
  // Direct resume by id / id prefix: one session = one conversation, so that id
  // IS the conversation.
  const sessions = await listResumableSessions(ctx);
  const match = sessions.find((s) => s.sessionId.startsWith(target));
  if (!match) {
    await reply(ctx, `❌ 未找到会话 \`${target}\`。发 \`/history\` 查看历史会话清单。`);
    return;
  }
  await applyResume(ctx, match);
}

/**
 * Resolve the working directory for a resumed session. The session's
 * recorded cwd is where OMP created its JSONL, so it is the only directory
 * the session can honestly be resumed from. Re-homing it (to the chat's
 * current cwd or $HOME) would make applyResume persist a (sessionId, cwd)
 * pair the session was never created in, and every later run would then
 * resume that JSONL from the wrong directory. Returns null when the recorded
 * directory is gone, so the caller can refuse instead.
 */
async function resolveSafeCwd(sessionCwd: string): Promise<string | null> {
  try {
    return (await stat(sessionCwd)).isDirectory() ? sessionCwd : null;
  } catch {
    return null;
  }
}

export async function applyResume(ctx: CommandContext, match: ResumeOption): Promise<void> {
  const target = match.sessionId;

  // 会话文件是恢复的唯一凭据：它可能已被清理（幽灵会话），此时不假装能续。
  const alive = new Set((await scanSessionFiles(ctx)).map((f) => f.sessionId));
  if (!alive.has(target)) {
    log.warn('command', 'resume-ghost-session', { scope: ctx.scope, sessionId: target });
    await reply(ctx, '❌ 这段会话的会话文件已不存在（可能被清理），无法恢复。');
    return;
  }

  // Ownership guard: another chat must not be actively using this session (two
  // OMP runs would interleave turns into the same JSONL).
  const owner = otherScopeHolding(ctx, target);
  if (owner !== undefined) {
    log.warn('command', 'resume-cross-scope-refused', { scope: ctx.scope, owner, sessionId: target });
    await reply(ctx, `❌ 会话 \`${target}\` 已被另一个会话（\`${owner}\`）占用，不能在这里恢复。`);
    return;
  }

  // 会话的 cwd 是它跑过的目录，也是唯一能诚实 resume 它的目录；目录没了就拒绝，
  // 不改写这条会话记录的工作目录。
  const sessionCwd = match.cwd || homedir();
  const cwd = await resolveSafeCwd(sessionCwd);
  if (!cwd) {
    log.warn('command', 'resume-cwd-missing', { scope: ctx.scope, sessionId: target, cwd: sessionCwd });
    await reply(
      ctx,
      `❌ 会话 \`${target}\` 的原目录 \`${sessionCwd}\` 已不存在，无法恢复（不会改写该会话记录的工作目录）。\n请发 \`/new\` 开始新对话，或先 \`/cd\` 切到该目录的上级后再试。`,
    );
    return;
  }

  const isCurrent = ctx.sessions.sessionFor(ctx.scope)?.sessionId === target;
  if (isCurrent) {
    log.info('command', 'resume-already-current', { scope: ctx.scope, sessionId: target, cwd });
    // 窗口 cwd 与会话保持一致（会话优先口径），即使本来就相同也写一次 —— 便宜的
    // 幂等写，保证 /ctx、卡片、下一次运行三者口径一致。
    ctx.workspaces.setCwd(ctx.scope, cwd);
    const summary = await loadSessionSummary(ctx, target);
    if (ctx.fromCardAction) {
      const msgId = ctx.msg.messageId;
      void (async () => {
        await new Promise((r) => setTimeout(r, FORM_SETTLE_MS));
        await updateManagedCard(
          ctx.channel,
          msgId,
          resumeSavedCard(target, cwd, renderContext(ctx, summary)),
        ).catch(() => {});
        forgetManagedCard(msgId);
      })();
    } else {
      void reply(ctx, `这个会话已经是当前会话。\n\n---\n\n${renderContext(ctx, summary)}`);
    }
    return;
  }

  // 切到那条会话：它带着自己的开始/最后活动时间，别把「现在」当成它的历史。
  ctx.activeRuns.interrupt(ctx.scope);
  ctx.workspaces.setCwd(ctx.scope, cwd);
  const createdAtMs = Date.parse(match.timestamp);
  ctx.sessions.bind(ctx.scope, target, cwd, {
    ...(Number.isFinite(createdAtMs) && createdAtMs > 0 ? { createdAtMs } : {}),
    ...(match.updatedAtMs !== undefined ? { updatedAtMs: match.updatedAtMs } : {}),
  });
  log.info('command', 'resume', { scope: ctx.scope, sessionId: target, cwd });
  const summary = await loadSessionSummary(ctx, target);
  if (ctx.fromCardAction) {
    const msgId = ctx.msg.messageId;
    void (async () => {
      await new Promise((r) => setTimeout(r, FORM_SETTLE_MS));
      await updateManagedCard(
        ctx.channel,
        msgId,
        resumeSavedCard(target, cwd, renderContext(ctx, summary)),
      ).catch(() => {});
      forgetManagedCard(msgId);
    })();
  } else {
    void reply(
      ctx,
      `✅ 已恢复会话 \`${target}\`\n📁 cwd: \`${cwd}\`\n下一条消息从该会话继续。\n\n---\n\n${renderContext(ctx, summary)}`,
    );
  }
}
