import { isAlive, resolveTarget } from '../../runtime/registry';
import type { CommandContext, Handler } from '../index';
import { reply, updateOrFallback } from '../shared';
import { psCard } from '../../card/templates';
import { psRowsFromRegistry } from './ps';
import { log } from '../../core/logger';

export const exitHandlers: Record<string, Handler> = {
  '/exit': handleExit,
};

const EXIT_USAGE =
  '用法:`/exit <id|#>` —— `id` 是 `/ps` 显示的短 id,`#` 是序号。\n' +
  '当前正在回复你的是 `%ID%`。';

/** 卡片点「退出」的第一步：只把 `/ps` 卡换成确认态，不碰任何进程。 */
async function renderPsConfirm(id: string, ctx: CommandContext): Promise<void> {
  await updateOrFallback(
    ctx,
    psCard(psRowsFromRegistry(ctx.controls.processId), { confirmId: id }),
    '⚠️ 请使用最新的 `/ps` 卡片继续操作。',
  );
}

/** 确认行里点了「取消」：把卡换回普通列表（原地，不新发一张）。 */
async function renderPsList(ctx: CommandContext): Promise<void> {
  await updateOrFallback(
    ctx,
    psCard(psRowsFromRegistry(ctx.controls.processId)),
    '📋 请重新发送 `/ps` 查看进程列表。',
  );
}

async function handleExit(args: string, ctx: CommandContext): Promise<void> {
  const trimmed = args.trim();
  const [head, ...tail] = trimmed.split(/\s+/);
  const rest = tail.join(' ').trim();

  // 卡片两步确认：`exit.ask <id>` 只换卡，`exit.cancel` 撤回确认。
  if (head === 'ask' && rest) {
    if (ctx.fromCardAction) {
      await renderPsConfirm(rest, ctx);
    } else {
      await reply(ctx, EXIT_USAGE.replace('%ID%', ctx.controls.processId));
    }
    return;
  }
  if (head === 'cancel' && ctx.fromCardAction) {
    await renderPsList(ctx);
    return;
  }

  const target = trimmed;
  if (!target) {
    await reply(ctx, EXIT_USAGE.replace('%ID%', ctx.controls.processId));
    return;
  }
  const entry = resolveTarget(target);
  if (!entry) {
    await reply(ctx, `❌ 没找到匹配的 bot:\`${target}\`。发 \`/ps\` 看可选目标。`);
    return;
  }

  if (entry.id === ctx.controls.processId) {
    log.info('command', 'exit-self', { id: entry.id });
    if (ctx.fromCardAction) {
      // 进程马上就没了：先把卡换成不再可点的告别态，再退出。
      await updateOrFallback(
        ctx,
        psCard(psRowsFromRegistry(ctx.controls.processId), { exitingSelf: true }),
        `👋 即将关闭当前 bot \`${entry.id}\`,再见。`,
      );
    } else {
      await reply(ctx, `👋 即将关闭当前 bot \`${entry.id}\`,再见。`);
    }
    void (async () => {
      await new Promise((r) => setTimeout(r, 300));
      await ctx.controls.exit().catch(() => {});
    })();
    return;
  }

  log.info('command', 'exit-other', { id: entry.id, pid: entry.pid });
  try {
    process.kill(entry.pid, 'SIGTERM');
  } catch (err) {
    await reply(ctx, `❌ 关掉 bot \`${entry.id}\` 失败:${(err as Error).message}`);
    return;
  }
  await new Promise((r) => setTimeout(r, 500));
  const stillAlive = isAlive(entry.pid);
  if (ctx.fromCardAction) {
    // 原地刷新卡片：已死的进程被 registry 剪掉（行消失即确认），仍在收尾的
    // 保留该行让用户重试 —— 而不是新发一张卡。
    await updateOrFallback(
      ctx,
      psCard(psRowsFromRegistry(ctx.controls.processId)),
      stillAlive
        ? `📨 已请求关闭 \`${entry.id}\`,但还在收尾。`
        : `✓ 已关闭 bot \`${entry.id}\`。`,
    );
    return;
  }
  if (stillAlive) {
    await reply(ctx, `📨 已请求关闭 \`${entry.id}\`,但还在收尾。再发 \`/ps\` 复查一下。`);
  } else {
    await reply(ctx, `✓ 已关闭 bot \`${entry.id}\`。`);
  }
}
