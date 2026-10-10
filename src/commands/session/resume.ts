import { homedir } from 'node:os';
import { stat } from 'node:fs/promises';
import { forgetManagedCard, sendManagedCard, updateManagedCard } from '../../card/managed';
import {
  resumeCard,
  resumeCancelledCard,
  resumeSavedCard,
  type ResumeOption,
} from '../../card/model-card';
import type { CommandContext, Handler } from '../index';
import { FORM_SETTLE_MS, recallMessage, reply } from '../shared';
import { renderContext, loadSessionSummary } from './context';
import { listWorkSessions, pickActiveSegment, scanSessionFiles } from './sessions';
import { log } from '../../core/logger';

export const resumeHandlers: Record<string, Handler> = {
  '/resume': handleResume,
  '/session': handleResume,
};

const RESUME_PAGE_SIZE = 5;

/**
 * 若另一个 scope 的**当前段**落在给定段集合里，返回那个 scope。
 *
 * 一次工作只应由一个 chat 恢复：同一 JSONL 被两个 OMP 进程 `--resume` 会让两边
 * 的回合交错写进同一个文件。到工作会话粒度后，「占用」= 对方当前段是本工作会话
 * 的任一段（不再只是单个 sessionId）。
 */
function occupyingScope(ctx: CommandContext, segmentIds: Iterable<string>): string | undefined {
  const ids = new Set(segmentIds);
  for (const scope of ctx.workSessions.chats()) {
    if (scope === ctx.scope) continue;
    const current = ctx.workSessions.activeWorkSession(scope)?.currentSegmentId;
    if (current !== undefined && ids.has(current)) return scope;
  }
  return undefined;
}

export async function listResumableSessions(ctx: CommandContext): Promise<ResumeOption[]> {
  // One row = one WORK session (same unit as /history). listWorkSessions already
  // sorts newest-activity-first; its `activeSegmentId` is the segment /resume
  // will adopt, so the picker and the resume target cannot diverge.
  const rows = await listWorkSessions(ctx);
  return rows
    .filter((r) => occupyingScope(ctx, r.segments.map((s) => s.sessionId)) === undefined)
    .map((r) => {
      const startedAtMs = Number.isFinite(r.startedAtMs) ? r.startedAtMs : r.lastActiveAtMs;
      return {
        sessionId: r.activeSegmentId ?? r.workSessionId,
        workSessionId: r.workSessionId,
        segmentCount: r.segmentCount,
        cwd: r.cwd,
        timestamp: new Date(startedAtMs).toISOString(),
        updatedAtMs: r.lastActiveAtMs,
        ...(r.title !== undefined ? { title: r.title } : {}),
        summary: r.topic ?? '',
      };
    });
}

async function handleResume(args: string, ctx: CommandContext): Promise<void> {
  const [sub, ...rest] = args.trim().split(/\s+/);

  if (sub === 'use') {
    const id = rest.join('');
    const sessions = await listResumableSessions(ctx);
    const match = sessions.find((s) => s.workSessionId === id || s.sessionId === id);
    if (!match) {
      await reply(ctx, `❌ 未找到会话 \`${id}\`。`);
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

  // Direct resume by id prefix: match a work session id or an OMP session id.
  const sessions = await listResumableSessions(ctx);
  const match = sessions.find(
    (s) => s.sessionId.startsWith(sub) || (s.workSessionId?.startsWith(sub) ?? false),
  );
  if (!match) {
    await reply(ctx, `❌ 未找到会话 \`${sub}\`。发 \`/resume\` 查看可恢复的会话列表。`);
    return;
  }
  await applyResume(ctx, match);
}

async function showResumePage(ctx: CommandContext, offset: number): Promise<void> {
  const sessions = await listResumableSessions(ctx);
  if (sessions.length === 0) {
    await reply(ctx, '没有找到可恢复的历史会话。');
    return;
  }
  const page = sessions.slice(offset, offset + RESUME_PAGE_SIZE);
  // The card keys rows on workSessionId, so mark the current WORK session.
  const currentId = ctx.workSessions.activeWorkSession(ctx.scope)?.id;
  if (ctx.fromCardAction) await recallMessage(ctx, ctx.msg.messageId);
  await sendManagedCard(
    ctx.channel,
    ctx.msg.chatId,
    resumeCard(currentId, page, { offset, total: sessions.length }),
  );
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
  // New payloads carry the work session id; older ones (or a bare
  // `/resume <sessionId>`) only carry an OMP session id.
  const ws =
    match.workSessionId !== undefined
      ? ctx.workSessions.workSessionById(match.workSessionId)
      : ctx.workSessions.workSessionForSegment(match.sessionId);

  // Same segment rule as the /history row: current segment if alive, else the
  // latest surviving one. Its cwd is the directory the session actually ran in.
  let target = match.sessionId;
  let segmentCwd = match.cwd || homedir();
  if (ws !== undefined) {
    const alive = new Set((await scanSessionFiles(ctx)).map((s) => s.sessionId));
    const picked = pickActiveSegment(ws, (id) => alive.has(id));
    if (picked !== undefined) {
      target = picked.sessionId;
      segmentCwd = picked.cwd || segmentCwd;
    }
  }

  // Ownership guard: another chat must not be actively using a segment of
  // this work session (two OMP runs would interleave the same JSONL).
  const segmentIds = ws !== undefined ? ws.segments.map((s) => s.sessionId) : [match.sessionId];
  const owner = occupyingScope(ctx, segmentIds);
  if (owner !== undefined) {
    log.warn('command', 'resume-cross-scope-refused', {
      scope: ctx.scope,
      owner,
      workSessionId: ws?.id,
      sessionId: target,
    });
    await reply(
      ctx,
      `❌ ${
        ws !== undefined ? `工作会话 \`${ws.id}\`` : `会话 \`${target}\``
      } 已被另一个会话（\`${owner}\`）占用，不能在这里恢复。`,
    );
    return;
  }

  const cwd = await resolveSafeCwd(segmentCwd);
  if (!cwd) {
    log.warn('command', 'resume-cwd-missing', {
      scope: ctx.scope,
      sessionId: target,
      cwd: segmentCwd,
    });
    await reply(
      ctx,
      `❌ 会话 \`${target}\` 的原目录 \`${segmentCwd}\` 已不存在，无法恢复（不会改写该会话记录的工作目录）。\n请发 \`/new\` 开始新会话，或先 \`/cd\` 切到该目录的上级后再试。`,
    );
    return;
  }

  const active = ctx.workSessions.activeWorkSession(ctx.scope);
  const isCurrent =
    ws !== undefined && active?.id === ws.id && active.currentSegmentId === target;
  if (isCurrent) {
    log.info('command', 'resume-already-current', {
      scope: ctx.scope,
      workSessionId: ws.id,
      sessionId: target,
      cwd,
    });
    // Keep the workspace cwd in sync with the resolved cwd so /context and
    // the card agree — even when it happens to equal the session's recorded
    // cwd, writing it is a cheap no-op that guarantees consistency.
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

  // Interrupt any active run, then adopt the work session: resumeFor(scope, cwd)
  // matches its (now current) segment on the next run.
  ctx.activeRuns.interrupt(ctx.scope);
  ctx.workspaces.setCwd(ctx.scope, cwd);
  if (ws !== undefined) {
    ctx.workSessions.adoptWorkSession(ctx.scope, ws.id, cwd, target);
  } else {
    // No work session claims this file (old/unclaimed history): bind it as a new
    // segment, keeping its OWN start/last-active times rather than "now".
    const startedAtMs = Date.parse(match.timestamp);
    ctx.workSessions.bindSegment(ctx.scope, target, cwd, {
      ...(Number.isFinite(startedAtMs) && startedAtMs > 0 ? { startedAtMs } : {}),
      ...(match.updatedAtMs !== undefined ? { lastActiveAtMs: match.updatedAtMs } : {}),
    });
  }
  log.info('command', 'resume', { scope: ctx.scope, workSessionId: ws?.id, sessionId: target, cwd });
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
      `✅ 已恢复${ws !== undefined ? `工作会话 \`${ws.id}\`` : `会话 \`${target}\``}\n📁 cwd: \`${cwd}\`\n下一条消息从该会话继续。\n\n---\n\n${renderContext(ctx, summary)}`,
    );
  }
}
