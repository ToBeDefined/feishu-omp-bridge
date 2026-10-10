import { homedir } from 'node:os';
import { HISTORY_PAGE_SIZE, historyCard, type HistoryRow } from '../../card/history-card';
import { historySegCard } from '../../card/history-seg-card';
import { recallMessage, reply } from '../shared';
import { sendManagedCard } from '../../card/managed';
import type { CommandContext, Handler } from '../index';
import { applyResume } from './resume';
import { listWorkSessions, scanSessionFiles } from './sessions';

export const historyHandlers: Record<string, Handler> = {
  '/history': handleHistory,
  // Alias: the card is the session ledger, and `/sessions` is what people type.
  '/sessions': handleHistory,
};

/**
 * `/history` (`/sessions`)          — past conversations in the CURRENT workspace
 * `/history all` (`/sessions all`)  — every past conversation, across workspaces
 * `/history seg <workSessionId>`    — the work session's segments, each restorable
 *
 * The listings are newest-activity-first, and every row carries a 继续对话 button.
 *
 * Card buttons arrive through the dispatcher's `cmd` → `sub arg` mapping:
 * - `{cmd:'history.page',   arg:'<mode> <offset>'}` → `page <mode> <offset>`
 * - `{cmd:'history.resume', arg:'<workSessionId>'}` → `resume <workSessionId>`
 *   (the 继续对话 button; restores the work session's ACTIVE segment) or
 * - `{cmd:'history.resume', arg:'<segmentId>'}`     → `resume <segmentId>`
 *   (a segment list's 恢复这一段 button; restores EXACTLY that segment)
 */
export async function handleHistory(args: string, ctx: CommandContext): Promise<void> {
  const tokens = args.trim().split(/\s+/).filter(Boolean);

  // A resume button carries either a work session id (the 继续对话 button) or
  // one of its segment ids (the segment list's 恢复这一段 button). Hand it to
  // applyResume, which owns the segment rule and the ownership / cwd guards.
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

  // Segment list: `/history seg <workSessionId>` renders one row per segment of
  // the work session, each with a 恢复这一段 button (payload → `resume <id>`,
  // which restores EXACTLY that segment). Per-segment stats come from the ONE
  // `scanSessionFiles` pass this command already owns — never a second walk.
  if (tokens[0] === 'seg') {
    const wsId = tokens.slice(1).join('');
    const ws = ctx.workSessions.workSessionById(wsId);
    if (ws === undefined) {
      await reply(ctx, `❌ 未找到工作会话 \`${wsId}\`，可能已被删除。`);
      return;
    }
    const byId = new Map((await scanSessionFiles(ctx)).map((f) => [f.sessionId, f]));
    const currentSegmentId = ctx.workSessions.activeWorkSession(ctx.scope)?.currentSegmentId;
    // Unnamed work session: fall back to the active segment's last user message,
    // so the header is not just "未命名".
    const topic = byId.get(
      currentSegmentId ?? ws.segments[ws.segments.length - 1]?.sessionId ?? '',
    )?.lastMessage;
    if (ctx.fromCardAction) await recallMessage(ctx, ctx.msg.messageId);
    await sendManagedCard(
      ctx.channel,
      ctx.msg.chatId,
      historySegCard({
        workSessionId: ws.id,
        segments: ws.segments.map((seg) => {
          const rec = byId.get(seg.sessionId);
          return {
            sessionId: seg.sessionId,
            cwd: seg.cwd,
            startedAtMs: seg.startedAtMs,
            lastActiveAtMs: rec?.updatedAtMs ?? seg.lastActiveAtMs,
            ...(rec !== undefined ? { turns: rec.turns } : {}),
            ...(rec?.lastMessage !== undefined ? { lastMessage: rec.lastMessage } : {}),
          };
        }),
        ...(ws.title !== undefined ? { title: ws.title } : {}),
        ...(topic !== undefined ? { topic } : {}),
        ...(currentSegmentId !== undefined ? { currentSegmentId } : {}),
      }),
    );
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

  const cwd = ctx.workspaces.cwdFor(ctx.scope) ?? homedir();
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
    workSessionId: s.workSessionId,
    updatedAtMs: s.lastActiveAtMs,
    turns: s.turns,
    segmentCount: s.segmentCount,
    workspace: workspaceLabel(ctx, s.cwd),
    scope: s.scope,
    ...(s.activeSegmentId !== undefined ? { activeSegmentId: s.activeSegmentId } : {}),
    ...(s.title !== undefined ? { title: s.title } : {}),
    ...(s.topic !== undefined ? { topic: s.topic } : {}),
  }));

  const currentWorkSessionId = ctx.workSessions.activeWorkSession(ctx.scope)?.id;
  if (ctx.fromCardAction) await recallMessage(ctx, ctx.msg.messageId);
  await sendManagedCard(
    ctx.channel,
    ctx.msg.chatId,
    historyCard(rows, {
      mode,
      cwd,
      offset: start,
      total: scoped.length,
      scope: ctx.scope,
      ...(currentWorkSessionId !== undefined ? { currentWorkSessionId } : {}),
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
