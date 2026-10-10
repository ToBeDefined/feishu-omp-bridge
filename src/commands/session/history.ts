import { HISTORY_PAGE_SIZE, historyCard, type HistoryRow } from '../../card/history-card';
import { recallMessage, reply } from '../shared';
import { sendManagedCard } from '../../card/managed';
import type { CommandContext, Handler } from '../index';
import { applyResume } from './resume';
import { conversationCwd } from '../../session/current-cwd';
import { listWorkSessions, scanSessionFiles } from './sessions';

export const historyHandlers: Record<string, Handler> = {
  '/history': handleHistory,
  // Alias: the card is the session ledger, and `/sessions` is what people type.
  '/sessions': handleHistory,
};

/**
 * `/history` (`/sessions`)          — past conversations in the CURRENT workspace
 * `/history all` (`/sessions all`)  — every past conversation, across workspaces
 *
 * One row = one OMP session = one conversation. Newest-activity-first, and every
 * row carries a 继续对话 button that restores exactly that conversation.
 *
 * Card buttons arrive through the dispatcher's `cmd` → `sub arg` mapping:
 * - `{cmd:'history.page',   arg:'<mode> <offset>'}` → `page <mode> <offset>`
 * - `{cmd:'history.resume', arg:'<sessionId>'}`     → `resume <sessionId>`
 */
export async function handleHistory(args: string, ctx: CommandContext): Promise<void> {
  const tokens = args.trim().split(/\s+/).filter(Boolean);

  // A resume button carries the id of the conversation it points at (the
  // 继续对话 button). Hand it to applyResume, which owns the ownership / cwd
  // guards and the work-session adoption.
  if (tokens[0] === 'resume') {
    const id = tokens.slice(1).join('');
    const ws =
      ctx.workSessions.workSessionById(id) ?? ctx.workSessions.workSessionForSegment(id);
    if (ws !== undefined) {
      const seg = ws.segments.find((s) => s.sessionId === id);
      await applyResume(ctx, {
        workSessionId: ws.id,
        // An id that IS one of the work session's segments = restore exactly
        // that segment; otherwise resume the work session (its active segment).
        ...(seg !== undefined ? { segmentId: id } : {}),
        sessionId: id,
        cwd: seg?.cwd ?? ws.cwd,
        timestamp: new Date(seg?.startedAtMs ?? ws.createdAtMs).toISOString(),
        ...(seg !== undefined ? { updatedAtMs: seg.lastActiveAtMs } : {}),
      });
      return;
    }
    // Unclaimed history file: its id IS its own OMP session id.
    const rec = (await scanSessionFiles(ctx)).find((s) => s.sessionId === id);
    if (!rec) {
      await reply(ctx, `❌ 未找到会话 \`${id}\`，可能已被删除。`);
      return;
    }
    await applyResume(ctx, {
      workSessionId: rec.sessionId,
      sessionId: rec.sessionId,
      cwd: rec.cwd,
      timestamp: rec.startedAt,
      updatedAtMs: rec.updatedAtMs,
    });
    return;
  }

  const unknown = tokens.filter((t) => t !== 'all' && t !== 'cwd' && t !== 'page' && !/^\d+$/.test(t));
  if (unknown.length > 0) {
    await reply(ctx, `❓ 用法：\`/history\`（当前工作目录）或 \`/history all\`（全部）。`);
    return;
  }
  const mode = tokens.includes('all') ? 'all' : 'cwd';
  const offsetToken = tokens.find((t) => /^\d+$/.test(t));
  const offset = offsetToken ? Number(offsetToken) : 0;

  // 默认视图 = 当前会话所在目录（会话优先；没有会话时才是聊天窗口的 cwd）。
  const cwd = conversationCwd(ctx.workspaces, ctx.workSessions, ctx.scope);
  const all = await listWorkSessions(ctx);
  // One row per work session; cwd mode filters on the work session's own cwd
  // (its LATEST segment), so a work session that crossed directories is not
  // dropped just because an older segment lived elsewhere.
  const scoped = mode === 'all' ? all : all.filter((s) => s.cwd === cwd);
  if (scoped.length === 0) {
    await reply(
      ctx,
      mode === 'all'
        ? '还没有任何历史会话。'
        : `\`${cwd}\` 下还没有历史会话（用 \`/history all\` 看全部工作目录）。`,
    );
    return;
  }
  // Paging past the end (a stale card button) should not render an empty page.
  const start = offset < scoped.length ? offset : 0;
  const rows: HistoryRow[] = scoped.map((s) => ({
    // 一个 OMP 会话 = 一个对话：行的身份就是那个会话，也正好是「继续对话」的载荷。
    sessionId: s.activeSegmentId ?? s.workSessionId,
    updatedAtMs: s.lastActiveAtMs,
    turns: s.turns,
    workspace: workspaceLabel(ctx, s.cwd),
    ...(s.title !== undefined ? { title: s.title } : {}),
    ...(s.topic !== undefined ? { topic: s.topic } : {}),
  }));

  const currentSessionId = ctx.workSessions.activeWorkSession(ctx.scope)?.currentSegmentId;
  if (ctx.fromCardAction) await recallMessage(ctx, ctx.msg.messageId);
  await sendManagedCard(
    ctx.channel,
    ctx.msg.chatId,
    historyCard(rows, {
      mode,
      cwd,
      offset: start,
      total: scoped.length,
      ...(currentSessionId !== undefined ? { currentSessionId } : {}),
    }),
  );
}

/** Named workspace pointing at `cwd`, else the collapsed path. */
function workspaceLabel(ctx: CommandContext, cwd: string): string {
  for (const [name, path] of Object.entries(ctx.workspaces.listNamed())) {
    if (path === cwd) return name;
  }
  return cwd;
}
