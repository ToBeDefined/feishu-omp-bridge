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
  '/every': handleEvery,
};

async function handleStop(_args: string, ctx: CommandContext): Promise<void> {
  const ok = ctx.activeRuns.interrupt(ctx.scope);
  log.info('command', 'stop', { interrupted: ok });
  // No reply: if there was a run, its in-flight render loop will mark the
  // card as 'interrupted' and re-render (`_⏹ 已被中断_`).
}

async function handleRestart(_args: string, ctx: CommandContext): Promise<void> {
  log.info('command', 'restart', { scope: ctx.scope });
  // Tell the user first — the old channel may be torn down once restart()
  // swaps the bridge, so this pre-notice is the reliable one.
  await reply(
    ctx,
    `🔄 正在重启当前 bot \`${ctx.controls.processId}\`…\n\n_采用进程内重连（先建新连接再断旧的），即使重连失败也会保留当前连接，不会掉线。约几秒完成。_`,
  );
  let restarted = false;
  try {
    await ctx.controls.restart();
    restarted = true;
    log.info('command', 'restart-ok');
  } catch (err) {
    log.fail('command', err, { step: 'restart' });
  }
  // After restart() the old bridge (and this ctx.channel) is disconnected,
  // so a post-restart reply may fail — that's expected, not a failure of the
  // restart itself. Report via log and rely on the startup notice if the
  // send doesn't land.
  try {
    if (restarted) {
      await reply(ctx, '✅ 重启完成，已重新连接。');
    } else {
      await reply(ctx, '❌ 重启失败，但原连接已保留，bot 仍在线。');
    }
  } catch (err) {
    log.fail('command', err, { step: 'restart-reply' });
  }
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

/**
 * Parse an interval like "30m", "2h", "1d" or a bare number of minutes into
 * milliseconds. Returns undefined for invalid input.
 */
function parseIntervalMs(raw: string): number | undefined {
  const m = /^(\d+)\s*(ms|s|m|h|d)?$/.exec(raw.trim());
  if (!m) return undefined;
  const n = Number(m[1]);
  if (!Number.isFinite(n) || n <= 0) return undefined;
  const unit = m[2] ?? 'm';
  const perUnit: Record<string, number> = { ms: 1, s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000 };
  return n * perUnit[unit]!;
}

async function handleEvery(args: string, ctx: CommandContext): Promise<void> {
  const scheduler = ctx.controls.scheduler;
  if (!scheduler) {
    await reply(ctx, '定时任务调度器不可用。');
    return;
  }
  const parts = args.trim().split(/\s+/);
  const sub = parts[0] ?? '';

  if (sub === 'list' || sub === '') {
    const tasks = scheduler.list();
    if (tasks.length === 0) {
      await reply(ctx, '当前没有定时任务。用法：`/every <间隔> <要定期执行的指令>`\n间隔如 `30m`/`2h`/`1d`。');
      return;
    }
    const lines = tasks.map((t, i) => {
      const interval = formatInterval(t.intervalMs);
      const next = new Date(t.nextRunAt);
      const hhmm = `${String(next.getHours()).padStart(2, '0')}:${String(next.getMinutes()).padStart(2, '0')}`;
      return `${i + 1}. \`${t.id}\` 每 ${interval} · 下次 ${hhmm} · ${t.prompt.slice(0, 40)}`;
    });
    await reply(ctx, `📅 **定时任务** (${tasks.length})\n\n${lines.join('\n')}\n\n发 \`/every rm <id>\` 删除某个任务。`);
    return;
  }

  if (sub === 'rm' || sub === 'remove') {
    const id = parts[1] ?? '';
    const removed = await scheduler.remove(id);
    await reply(ctx, removed ? `✅ 已删除定时任务 \`${id}\`` : `❌ 未找到定时任务 \`${id}\``);
    return;
  }

  if (sub.startsWith('/')) {
    await reply(ctx, '用法：`/every <间隔> <指令>` / `/every list` / `/every rm <id>`');
    return;
  }

  // /every <interval> <prompt...>
  const intervalMs = parseIntervalMs(sub);
  if (!intervalMs) {
    await reply(ctx, '❌ 无法解析间隔。用法：`/every 30m "指令"`（支持 ms/s/m/h/d）。');
    return;
  }
  const prompt = parts.slice(1).join(' ').trim();
  if (!prompt) {
    await reply(ctx, '❌ 缺少要定期执行的指令。用法：`/every 30m "检查 git 状态并汇报"`');
    return;
  }
  const task = await scheduler.add({
    chatId: ctx.scope.startsWith('oc_') || ctx.scope.startsWith('cg_') ? ctx.scope : ctx.msg.chatId,
    prompt,
    intervalMs,
  });
  await reply(
    ctx,
    `✅ 已添加定时任务 \`${task.id}\`\n每 ${formatInterval(intervalMs)} 执行一次：${prompt}\n\n用 \`/every list\` 查看，\`/every rm ${task.id}\` 删除。`,
  );
}

function formatInterval(ms: number): string {
  if (ms % 86_400_000 === 0) return `${ms / 86_400_000} 天`;
  if (ms % 3_600_000 === 0) return `${ms / 3_600_000} 小时`;
  if (ms % 60_000 === 0) return `${ms / 60_000} 分钟`;
  return `${ms / 1000} 秒`;
}
