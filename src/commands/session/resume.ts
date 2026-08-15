import { homedir } from 'node:os';
import { readdir, readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { paths } from '../../config/paths';
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

async function listResumableSessions(ctx: CommandContext): Promise<ResumeOption[]> {
  const dir = paths.ompSessionsDir;
  const titles = ctx.sessions.titlesBySessionId();
  const out: ResumeOption[] = [];
  try {
    const entries = await readdir(dir);
    for (const name of entries) {
      if (!name.endsWith('.jsonl')) continue;
      try {
        const text = await readFile(join(dir, name), 'utf8');
        const { meta, lastAssistant, lastUserMessage } = scanSessionFile(text);
        if (!meta?.id || !meta.cwd) continue;
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
 * Resolve the working directory to use for a resumed session. The session's
 * recorded cwd may point at a deleted/renamed directory; spawning omp there
 * fails with ENOENT. Walk candidates — session cwd, the chat's current
 * workspace cwd, then $HOME — and take the first that exists.
 */
async function resolveSafeCwd(
  ctx: CommandContext,
  sessionCwd: string,
): Promise<{ cwd: string; warn: string }> {
  const candidates: Array<{ path?: string; label: string }> = [
    { path: sessionCwd, label: `会话原目录 \`${sessionCwd}\`` },
    { path: ctx.workspaces.cwdFor(ctx.scope), label: '当前工作目录' },
    { path: homedir(), label: `home 目录 \`${homedir()}\`` },
  ];
  for (const cand of candidates) {
    if (!cand.path) continue;
    let ok = false;
    try {
      ok = (await stat(cand.path)).isDirectory();
    } catch {
      ok = false;
    }
    if (!ok) continue;
    const warn =
      cand.label !== `会话原目录 \`${sessionCwd}\``
        ? `会话原目录 \`${sessionCwd}\` 已不存在,回退到${cand.label}。`
        : '';
    return { cwd: cand.path, warn };
  }
  return { cwd: homedir(), warn: '' }; // unreachable — homedir exists
}

export async function applyResume(ctx: CommandContext, match: ResumeOption): Promise<void> {
  const currentId = ctx.sessions.getRaw(ctx.scope)?.sessionId;
  const isCurrent = currentId !== undefined && match.sessionId === currentId;
  // Always resolve a safe cwd — even for the current session, its recorded
  // cwd may have been deleted since, which would still break the next spawn.
  const { cwd, warn } = await resolveSafeCwd(ctx, match.cwd || homedir());
  if (isCurrent) {
    log.info('command', 'resume-already-current', { scope: ctx.scope, sessionId: match.sessionId, cwd });
    // Keep the workspace cwd in sync with the resolved cwd so /context and
    // the card agree — even when it happens to equal the session's recorded
    // cwd, writing it is a cheap no-op that guarantees consistency.
    ctx.workspaces.setCwd(ctx.scope, cwd);
    const summary = await loadSessionSummary(match.sessionId);
    const warnBlock = warn ? `\n⚠️ ${warn}\n` : '';
    if (ctx.fromCardAction) {
      const msgId = ctx.msg.messageId;
      void (async () => {
        await new Promise((r) => setTimeout(r, FORM_SETTLE_MS));
        await updateManagedCard(
          ctx.channel,
          msgId,
          resumeSavedCard(match.sessionId, cwd, `${warnBlock}${renderContext(ctx, summary)}`),
        ).catch(() => {});
        forgetManagedCard(msgId);
      })();
    } else {
      void reply(ctx, `这个会话已经是当前会话。${warnBlock}\n\n---\n\n${renderContext(ctx, summary)}`);
    }
    return;
  }
  // Interrupt any active run, then re-point this chat's session + cwd at
  // the historical session. resumeFor(scope, cwd) will match next run.
  ctx.activeRuns.interrupt(ctx.scope);
  ctx.workspaces.setCwd(ctx.scope, cwd);
  ctx.sessions.set(ctx.scope, match.sessionId, cwd);
  log.info('command', 'resume', {
    scope: ctx.scope,
    sessionId: match.sessionId,
    cwd,
    cwdWarn: warn || undefined,
  });
  const summary = await loadSessionSummary(match.sessionId);
  const warnBlock = warn ? `\n⚠️ ${warn}\n` : '';
  if (ctx.fromCardAction) {
    const msgId = ctx.msg.messageId;
    void (async () => {
      await new Promise((r) => setTimeout(r, FORM_SETTLE_MS));
      await updateManagedCard(
        ctx.channel,
        msgId,
        resumeSavedCard(match.sessionId, cwd, `${warnBlock}${renderContext(ctx, summary)}`),
      ).catch(() => {});
      forgetManagedCard(msgId);
    })();
  } else {
    void reply(
      ctx,
      `✅ 已恢复会话 \`${match.sessionId}\`\n📁 cwd: \`${cwd}\`${warnBlock}\n下一条消息从该会话继续。\n\n---\n\n${renderContext(ctx, summary)}`,
    );
  }
}


