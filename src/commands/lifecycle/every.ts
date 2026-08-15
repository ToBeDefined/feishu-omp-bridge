import type { CommandContext, Handler } from '../index';
import { reply } from '../shared';

export const everyHandlers: Record<string, Handler> = {
  '/every': handleEvery,
};

function parseIntervalMs(raw: string): number | undefined {
  const m = /^(\d+)\s*(ms|s|m|h|d)?$/.exec(raw.trim());
  if (!m) return undefined;
  const n = Number(m[1]);
  if (!Number.isFinite(n) || n <= 0) return undefined;
  const unit = m[2] ?? 'm';
  const perUnit: Record<string, number> = { ms: 1, s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000 };
  return n * perUnit[unit]!;
}

function formatInterval(ms: number): string {
  if (ms % 86_400_000 === 0) return `${ms / 86_400_000} 天`;
  if (ms % 3_600_000 === 0) return `${ms / 3_600_000} 小时`;
  if (ms % 60_000 === 0) return `${ms / 60_000} 分钟`;
  return `${ms / 1000} 秒`;
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
