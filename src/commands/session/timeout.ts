import type { CommandContext, Handler } from '../index';
import { getRunIdleTimeoutMs } from '../../config/schema';
import { sendManagedCard } from '../../card/managed';
import { timeoutCard } from '../../card/templates';
import { reply, updateOrFallback } from '../shared';
import { log } from '../../core/logger';

export const timeoutHandlers: Record<string, Handler> = {
  '/timeout': handleTimeout,
};

/** 合法区间（含端点）—— 与 SessionStore.setIdleTimeoutMinutes 的 clamp 一致。 */
const MIN_MINUTES = 1;
const MAX_MINUTES = 120;

async function handleTimeout(args: string, ctx: CommandContext): Promise<void> {
  const trimmed = args.trim().toLowerCase();
  const globalMs = getRunIdleTimeoutMs(ctx.controls.cfg);
  const globalMinutes = globalMs ? Math.round(globalMs / 60_000) : 0;
  const globalLabel = globalMinutes > 0 ? `全局默认：${globalMinutes} 分钟` : '全局默认：未启用';
  // 当前值口径属于命令层：卡片只收到拼好的两行，不持有配置逻辑。
  const currentLabel = (): string => {
    const scopeMinutes = ctx.sessions.getIdleTimeoutMinutes(ctx.scope);
    if (scopeMinutes === undefined) {
      return `当前 session 探活：跟随全局（${globalMinutes > 0 ? `${globalMinutes} 分钟` : '未启用'}）`;
    }
    return scopeMinutes > 0 ? `当前 session 探活：${scopeMinutes} 分钟` : '当前 session 探活：已关闭';
  };
  const card = (notice?: string, cancelled?: boolean): object =>
    timeoutCard({
      current: currentLabel(),
      global: globalLabel,
      ...(notice !== undefined ? { notice } : {}),
      ...(cancelled ? { cancelled: true } : {}),
    });
  // 卡片路径（点按钮进来）：原地更新这张卡；文本路径（手打命令）：回一条文本。
  const settle = async (notice: string, opts: { cancelled?: boolean } = {}): Promise<void> => {
    if (ctx.fromCardAction) {
      // 取消时卡片自己带终态说明，别再叠一行同样的 notice。
      const next = card(opts.cancelled ? undefined : notice, opts.cancelled);
      await updateOrFallback(ctx, next, opts.cancelled ? '已取消操作，未做修改。' : notice);
      return;
    }
    await reply(ctx, notice);
  };

  // 无参：发这张设置卡（不再把整段用法塞进一条文本）。
  if (!trimmed) {
    if (ctx.fromCardAction) {
      await updateOrFallback(ctx, card(), '⏱ 请使用最新的 `/timeout` 卡片继续操作。');
      return;
    }
    try {
      await sendManagedCard(ctx.channel, ctx.msg.chatId, card(), ctx.msg.messageId);
    } catch (err) {
      log.fail('command', err, { step: 'timeout-card' });
      // 卡片发不出去：退回原来的纯文本用法，别让命令看起来没反应。
      await reply(ctx, textUsage(currentLabel(), globalLabel));
    }
    return;
  }

  if (trimmed === 'cancel') {
    await settle('已取消操作，未做修改。', { cancelled: true });
    return;
  }

  if (trimmed === 'default') {
    const cleared = ctx.sessions.clearIdleTimeoutOverride(ctx.scope);
    log.info('command', 'timeout-clear', { scope: ctx.scope, cleared });
    await settle(
      cleared
        ? `✅ 已清除 session 覆盖，回退到全局（${globalMinutes > 0 ? `${globalMinutes} 分钟` : '未启用'}）。`
        : `当前 session 本来就没设过覆盖，跟随全局（${globalMinutes > 0 ? `${globalMinutes} 分钟` : '未启用'}）。`,
    );
    return;
  }

  if (trimmed === 'off' || trimmed === '0') {
    ctx.sessions.setIdleTimeoutMinutes(ctx.scope, 0);
    log.info('command', 'timeout-off', { scope: ctx.scope });
    await settle('✅ 已关闭当前 session 的探活。');
    return;
  }

  // 严格整数解析：`parseInt` 会把 `1e3` 读成 1、`1.5` 读成 1 —— 静默改错值比
  // 报错更糟。只接受十进制整数。
  const n = /^\d+$/.test(trimmed) ? Number(trimmed) : Number.NaN;
  if (!Number.isInteger(n) || n < MIN_MINUTES || n > MAX_MINUTES) {
    await settle(
      `❌ 无效的超时值：${trimmed}。请输入 ${MIN_MINUTES}-${MAX_MINUTES} 的整数分钟，或 off / default。`,
    );
    return;
  }
  ctx.sessions.setIdleTimeoutMinutes(ctx.scope, n);
  log.info('command', 'timeout-set', { scope: ctx.scope, minutes: n });
  await settle(`✅ 当前 session 探活已设为 ${n} 分钟。`);
}

/** 卡片发不出去时的纯文本兜底：当前值 + 一行用法（不再是整段说明）。 */
function textUsage(current: string, global: string): string {
  return `⏱ ${current}\n${global}\n\n用法：\`/timeout <${MIN_MINUTES}-${MAX_MINUTES}>\` · \`/timeout off\` · \`/timeout default\``;
}
