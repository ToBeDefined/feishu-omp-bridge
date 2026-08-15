import { isAlive, readAndPrune, resolveTarget } from '../runtime/registry';
import { helpCard } from '../card/templates';
import type { CommandContext, Handler } from './index';
import { formatAgo, reply } from './shared';
import { log } from '../core/logger';

export const lifecycleHandlers: Record<string, Handler> = {
  '/stop': handleStop,
  '/restart': handleRestart,
  '/reconnect': handleReconnect,
  '/ps': handlePs,
  '/exit': handleExit,
  '/help': handleHelp,
};

async function handleStop(_args: string, ctx: CommandContext): Promise<void> {
  const ok = ctx.activeRuns.interrupt(ctx.scope);
  log.info('command', 'stop', { interrupted: ok });
  // No reply: if there was a run, its in-flight render loop will mark the
  // card as 'interrupted' and re-render (`_⏹ 已被中断_`).
}

async function handleRestart(_args: string, ctx: CommandContext): Promise<void> {
  log.info('command', 'restart', { scope: ctx.scope });
  await reply(ctx, `🔄 即将重启当前 bot \`${ctx.controls.processId}\`…\n\n_launchd 会自动拉起新实例,约几秒后恢复。期间消息会暂时无法响应。_`);
  // Detach so the reply send completes before we tear down.
  void (async () => {
    await new Promise((r) => setTimeout(r, 800));
    await ctx.controls.exit().catch(() => {});
  })();
}

async function handleReconnect(_args: string, ctx: CommandContext): Promise<void> {
  log.info('command', 'reconnect');
  await reply(ctx, '⏳ 正在重连…');
  try {
    await ctx.controls.restart();
    log.info('command', 'reconnect-ok');
  } catch (err) {
    log.fail('command', err, { step: 'reconnect' });
    await reply(ctx, `❌ 重连失败:${err instanceof Error ? err.message : String(err)}`);
  }
}

async function handlePs(_args: string, ctx: CommandContext): Promise<void> {
  const live = readAndPrune();
  log.info('command', 'ps', { count: live.length });
  if (live.length === 0) {
    await reply(ctx, '当前没有 bot 在运行(理论上不可能,你正在跟其中之一对话…)');
    return;
  }

  const rows: string[] = [
    '| # | ID | Bot | 启动 |',
    '|---|---|---|---|',
  ];
  for (const [idx, e] of live.entries()) {
    const ago = formatAgo(Date.now() - new Date(e.startedAt).getTime());
    const me = e.id === ctx.controls.processId ? ' ← 当前正在回复' : '';
    const bot = e.botName ? `${e.botName} (\`${e.appId}\`)` : `\`${e.appId}\``;
    rows.push(`| ${idx + 1} | \`${e.id}\`${me} | ${bot} | ${ago} |`);
  }
  const body = [
    `🧭 **当前有 ${live.length} 个 bot 在运行**`,
    '',
    rows.join('\n'),
    '',
    '用 `/exit <id|#>` 关掉某一个;`/exit ' + ctx.controls.processId + '` 关掉正在回复你的这个 bot。',
  ].join('\n');
  await reply(ctx, body);
}

async function handleExit(args: string, ctx: CommandContext): Promise<void> {
  const target = args.trim();
  if (!target) {
    await reply(
      ctx,
      '用法:`/exit <id|#>` —— `id` 是 `/ps` 显示的短 id,`#` 是序号。\n' +
        `当前正在回复你的是 \`${ctx.controls.processId}\`。`,
    );
    return;
  }
  const entry = resolveTarget(target);
  if (!entry) {
    await reply(ctx, `❌ 没找到匹配的 bot:\`${target}\`。发 \`/ps\` 看可选目标。`);
    return;
  }

  // Targeting ourselves — graceful disconnect + process.exit(0) via controls.
  if (entry.id === ctx.controls.processId) {
    log.info('command', 'exit-self', { id: entry.id });
    await reply(ctx, `👋 即将关闭当前 bot \`${entry.id}\`,再见。`);
    // Detach to give the reply send a chance to complete before we tear
    // down. controls.exit() awaits disconnect then process.exit().
    void (async () => {
      await new Promise((r) => setTimeout(r, 300));
      await ctx.controls.exit().catch(() => {});
    })();
    return;
  }

  // Targeting another process — SIGTERM and report back. We can't easily
  // wait for it to die without blocking the command handler; trust the
  // target's own signal handler to unregister + exit.
  log.info('command', 'exit-other', { id: entry.id, pid: entry.pid });
  try {
    process.kill(entry.pid, 'SIGTERM');
  } catch (err) {
    await reply(ctx, `❌ 关掉 bot \`${entry.id}\` 失败:${(err as Error).message}`);
    return;
  }
  // Brief grace before reporting.
  await new Promise((r) => setTimeout(r, 500));
  const stillAlive = isAlive(entry.pid);
  if (stillAlive) {
    await reply(
      ctx,
      `📨 已请求关闭 \`${entry.id}\`,但还在收尾。再发 \`/ps\` 复查一下。`,
    );
  } else {
    await reply(ctx, `✓ 已关闭 bot \`${entry.id}\`。`);
  }
}

async function handleHelp(_args: string, ctx: CommandContext): Promise<void> {
  const card = helpCard();
  await ctx.channel.send(ctx.msg.chatId, { card }, { replyTo: ctx.msg.messageId });
}
