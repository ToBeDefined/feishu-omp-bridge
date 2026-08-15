import type { CommandContext, Handler } from '../index';
import { recallMessage, reply } from '../shared';
import { workspacesCard } from '../../card/templates';
import { log } from '../../core/logger';

export const wsHandlers: Record<string, Handler> = {
  '/ws': handleWs,
};

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
    case 'undo':
      return handleWsUndo(ctx);
    case 'cancel':
      if (ctx.fromCardAction) await recallMessage(ctx, ctx.msg.messageId);
      return;
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
  await reply(ctx, `✅ 工作空间已保存：\`${name}\` → ${cwd}`);
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
  const prevCwd = ctx.workspaces.cwdFor(ctx.scope);
  if (prevCwd && prevCwd !== cwd) {
    ctx.workspaces.rememberPreviousCwd(ctx.scope, prevCwd);
  }
  ctx.activeRuns.interrupt(ctx.scope);
  ctx.workspaces.setCwd(ctx.scope, cwd);
  ctx.sessions.clear(ctx.scope);
  const undoHint =
    prevCwd && prevCwd !== cwd
      ? `\n\n想撤回？发 \`/ws undo\` 回到 \`${prevCwd}\``
      : '';
  const confirm = `✅ 已切换到 \`${name}\` (${cwd})\n（session 已重置）${undoHint}`;
  // When triggered from the panel button, send the confirmation as a
  // standalone message (not threaded under the panel), then dismiss the
  // panel. Threading under the panel and deleting the panel would take the
  // confirmation down with it.
  if (ctx.fromCardAction) {
    try {
      await ctx.channel.send(ctx.msg.chatId, { markdown: confirm });
    } catch (err) {
      log.fail('command', err, { step: 'ws-use-reply' });
    }
    await recallMessage(ctx, ctx.msg.messageId);
  } else {
    await reply(ctx, confirm);
  }
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
  await reply(ctx, `✅ 已删除工作空间：\`${name}\``);
}

async function handleWsUndo(ctx: CommandContext): Promise<void> {
  const target = ctx.workspaces.undoTarget(ctx.scope);
  if (!target) {
    await reply(ctx, '没有可撤回的工作区切换（之前没用 `/ws use` 切换过）。');
    return;
  }
  ctx.activeRuns.interrupt(ctx.scope);
  ctx.workspaces.setCwd(ctx.scope, target);
  ctx.workspaces.clearUndo(ctx.scope);
  ctx.sessions.clear(ctx.scope);
  await reply(ctx, `↩️ 已撤回工作区切换，回到 \`${target}\`\n（session 已重置）`);
}
