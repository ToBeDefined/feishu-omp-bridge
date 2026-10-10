import { homedir } from 'node:os';
import { HISTORY_PAGE_SIZE, historyCard, type HistoryRow } from '../../card/history-card';
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
 *
 * Both are newest-activity-first, and every row carries a 继续对话 button.
 *
 * Card buttons arrive through the dispatcher's `cmd` → `sub arg` mapping:
 * - `{cmd:'history.page',   arg:'<mode> <offset>'}`    → `page <mode> <offset>`
 * - `{cmd:'history.resume', arg:'<workSessionId>'}`    → `resume <workSessionId>`
 */
export async function handleHistory(args: string, ctx: CommandContext): Promise<void> {
  const tokens = args.trim().split(/\s+/).filter(Boolean);

  // 继续对话 button: the payload is a WORK session id. Hand it to applyResume,
  // which picks the SAME segment `listWorkSessions` used for the row's topic
  // (current-if-alive, else latest alive) — so the button restores exactly the
  // conversation the row described.
  if (tokens[0] === 'resume') {
    const workSessionId = tokens.slice(1).join('');
    const ws = ctx.workSessions.workSessionById(workSessionId);
    if (ws !== undefined) {
      await applyResume(ctx, {
        workSessionId,
        sessionId: ws.currentSegmentId ?? workSessionId,
        cwd: ws.cwd,
        timestamp: new Date(ws.createdAtMs).toISOString(),
      });
      return;
    }
    // Unclaimed history file: its workSessionId IS its own OMP session id.
    const rec = (await scanSessionFiles(ctx)).find((s) => s.sessionId === workSessionId);
    if (!rec) {
      await reply(ctx, `❌ 未找到会话 \`${workSessionId}\`，可能已被删除。`);
      return;
    }
    await applyResume(ctx, {
      workSessionId,
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
