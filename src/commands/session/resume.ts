import { homedir } from 'node:os';
import { readdir, readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { getOmpSessionDir } from '../../config/schema';
import { forgetManagedCard, sendManagedCard, updateManagedCard } from '../../card/managed';
import {
  resumeCard,
  resumeCancelledCard,
  resumeSavedCard,
  type ResumeOption,
} from '../../card/model-card';
import type { CommandContext, Handler } from '../index';
import { FORM_SETTLE_MS, recallMessage, reply } from '../shared';
import { renderContext, loadSessionSummary, scanSessionFile } from './context';
import { log } from '../../core/logger';

export const resumeHandlers: Record<string, Handler> = {
  '/resume': handleResume,
  '/session': handleResume,
};

const RESUME_PAGE_SIZE = 5;

/** Map sessionId → the scope currently bound to it. A session is a single
 * JSONL file: letting two chats resume it would make both OMP processes
 * `--resume` the same file and interleave their turns. */
function boundScopeBySession(ctx: CommandContext): Map<string, string> {
  const map = new Map<string, string>();
  for (const scope of ctx.sessions.chats()) {
    const entry = ctx.sessions.getRaw(scope);
    if (entry?.sessionId) map.set(entry.sessionId, scope);
  }
  return map;
}

export async function listResumableSessions(ctx: CommandContext): Promise<ResumeOption[]> {
  const dir = getOmpSessionDir(ctx.controls.cfg);
  const titles = ctx.sessions.titlesBySessionId();
  const bound = boundScopeBySession(ctx);
  const out: ResumeOption[] = [];
  try {
    const entries = await readdir(dir);
    for (const name of entries) {
      if (!name.endsWith('.jsonl')) continue;
      try {
        const text = await readFile(join(dir, name), 'utf8');
        const { meta, lastAssistant, lastUserMessage } = scanSessionFile(text);
        if (!meta?.id || !meta.cwd) continue;
        // Never offer a session another scope already owns.
        const owner = bound.get(meta.id);
        if (owner !== undefined && owner !== ctx.scope) continue;
        const title = titles[meta.id];
        out.push({
          sessionId: meta.id,
          cwd: meta.cwd,
          timestamp: meta.timestamp ?? name,
          ...(title !== undefined ? { title } : {}),
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
    const sessions = await listResumableSessions(ctx);
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
  const sessions = await listResumableSessions(ctx);
  const match = sessions.find((s) => s.sessionId.startsWith(sub));
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
  const currentId = ctx.sessions.getRaw(ctx.scope)?.sessionId;
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
  // Defensive copy of the ownership guard in listResumableSessions: a card
  // button carries a session id that another chat may have claimed since.
  const owner = boundScopeBySession(ctx).get(match.sessionId);
  if (owner !== undefined && owner !== ctx.scope) {
    log.warn('command', 'resume-cross-scope-refused', {
      scope: ctx.scope,
      owner,
      sessionId: match.sessionId,
    });
    await reply(ctx, `❌ 会话 \`${match.sessionId}\` 已被另一个会话（\`${owner}\`）占用，不能在这里恢复。`);
    return;
  }
  const sessionCwd = match.cwd || homedir();
  const cwd = await resolveSafeCwd(sessionCwd);
  if (!cwd) {
    log.warn('command', 'resume-cwd-missing', {
      scope: ctx.scope,
      sessionId: match.sessionId,
      cwd: sessionCwd,
    });
    await reply(
      ctx,
      `❌ 会话 \`${match.sessionId}\` 的原目录 \`${sessionCwd}\` 已不存在，无法恢复（不会改写该会话记录的工作目录）。\n请发 \`/new\` 开始新会话，或先 \`/cd\` 切到该目录的上级后再试。`,
    );
    return;
  }
  const currentId = ctx.sessions.getRaw(ctx.scope)?.sessionId;
  const isCurrent = currentId !== undefined && match.sessionId === currentId;
  if (isCurrent) {
    log.info('command', 'resume-already-current', { scope: ctx.scope, sessionId: match.sessionId, cwd });
    // Keep the workspace cwd in sync with the resolved cwd so /context and
    // the card agree — even when it happens to equal the session's recorded
    // cwd, writing it is a cheap no-op that guarantees consistency.
    ctx.workspaces.setCwd(ctx.scope, cwd);
    const summary = await loadSessionSummary(ctx, match.sessionId);
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
      void reply(ctx, `这个会话已经是当前会话。\n\n---\n\n${renderContext(ctx, summary)}`);
    }
    return;
  }
  // Interrupt any active run, then re-point this chat's session + cwd at
  // the historical session. resumeFor(scope, cwd) will match next run.
  ctx.activeRuns.interrupt(ctx.scope);
  ctx.workspaces.setCwd(ctx.scope, cwd);
  ctx.sessions.set(ctx.scope, match.sessionId, cwd);
  log.info('command', 'resume', { scope: ctx.scope, sessionId: match.sessionId, cwd });
  const summary = await loadSessionSummary(ctx, match.sessionId);
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
      `✅ 已恢复会话 \`${match.sessionId}\`\n📁 cwd: \`${cwd}\`\n下一条消息从该会话继续。\n\n---\n\n${renderContext(ctx, summary)}`,
    );
  }
}


