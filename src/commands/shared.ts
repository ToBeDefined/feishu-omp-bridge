import { homedir } from 'node:os';
import type { CommandContext } from './index';
import { log } from '../core/logger';
import { forgetManagedCard, sendManagedCard, updateManagedCard } from '../card/managed';
import { md, staleNoticeCard } from '../card/templates';

/** Rendered idle-timeout line: scope override wins over the global default. */
export function formatIdleLine(
  scopeMinutes: number | undefined,
  globalMinutes: number,
): string {
  if (scopeMinutes !== undefined) {
    return scopeMinutes > 0 ? `本会话 ${scopeMinutes} 分钟` : '本会话已关闭';
  }
  return globalMinutes > 0 ? `全局 ${globalMinutes} 分钟` : '未启用（不自动中断任务）';
}

/** Delay before in-place card updates, letting the Feishu client settle. */
export const FORM_SETTLE_MS = 1000;

/**
 * Grace wait before bouncing the process (/release, /restart): text replies
 * travel the WS pipeline, and launchd's SIGTERM drops not-yet-flushed
 * outbound frames — the release/restart notices used to vanish silently.
 * Latest measured round-trip leaves plenty of headroom at 800ms.
 */
export const RESTART_FLUSH_GRACE_MS = 800;

/**
 * Send a plain markdown reply, swallowing any send error. Used by command
 * handlers where a failed reply shouldn't bubble up and crash the bot —
 * losing the message is better than dying.
 */
export async function reply(ctx: CommandContext, markdown: string): Promise<void> {
  try {
    await ctx.channel.send(ctx.msg.chatId, { markdown }, { replyTo: ctx.msg.messageId });
  } catch (err) {
    log.fail('command', err, { step: 'reply' });
  }
}

/**
 * 解析 `/release force` / `/restart force` 的布尔开关。
 *
 * 只认 `force` / `--force` / `-f`（大小写不敏感）。**别的 token 一律报用法**而不是
 * 当作「没写 force」继续：否则打错一个字就会退化成等 5 分钟排空，用户只会觉得命令卡住。
 */
export function parseForceArg(
  args: string,
  usage: string,
): { ok: true; force: boolean } | { ok: false; message: string } {
  let force = false;
  for (const token of args.trim().split(/\s+/).filter(Boolean)) {
    if (/^(?:force|--force|-f)$/i.test(token)) force = true;
    else return { ok: false, message: `⚠️ 无法识别的参数「${token}」。用法：${usage}` };
  }
  return { ok: true, force };
}

export function expandTilde(p: string): string {
  if (p === '~') return homedir();
  if (p.startsWith('~/')) return `${homedir()}${p.slice(1)}`;
  return p;
}

/**
 * 把表单 / 选择器卡片原地收尾成终态（已取消 / 已过期）。
 *
 * 卡片可能**不在本进程的托管表里**：重启前发出的老卡片、或卡片是在 bridge 之外发的
 * （手工调试）。此时原地更新必然失败 —— 不能静默，否则用户点了「取消」什么都不发生，
 * 看起来就是坏了。退回一条简短回复。
 */
export async function settleManagedCard(
  ctx: CommandContext,
  card: object,
  fallbackText: string,
): Promise<void> {
  await new Promise((r) => setTimeout(r, FORM_SETTLE_MS));
  await updateOrFallback(ctx, card, fallbackText);
}

/**
 * 卡片原地更新不了时的兜底文案。触发场景：重启前发出的老卡片、bridge 之外发的
 * 卡片 —— 按钮还亮着，但点了已经没有任何去处，必须说清楚而不是静默。
 */
export const EXPIRED_INTERACTION_TEXT = '⚠️ 此交互已过期，请使用最新卡片。';

/**
 * 在原卡片末尾补一行「已过期」提示，其余元素一个不动。
 *
 * 用于 `updateOrFallback` 的兜底卡：终态卡（如 OMP 交互结果卡）本身已经回答不了
 * 「点了没反应」，再补一行说明才闭环。入参是 patch / CardKit 更新共用的 `object`，
 * 所以这里就地收窄形状；拿不到 `body.elements` 就原样返回。
 */
export function withExpiryNotice(card: object): object {
  if (!('body' in card)) return card;
  const body = card.body;
  if (typeof body !== 'object' || body === null || !('elements' in body)) return card;
  const elements = body.elements;
  if (!Array.isArray(elements)) return card;
  return {
    ...card,
    body: { ...body, elements: [...elements, md(`_${EXPIRED_INTERACTION_TEXT}_`)] },
  };
}

/**
 * `settleManagedCard` 的核心（不含 FORM_SETTLE_MS 延迟）：调用方自己等过了
 * （表单提交那几条路径要等「距提交已过 N 毫秒」而不是固定 N 毫秒）就用这个。
 *
 * 两种用途：
 * - **终态卡**（默认 `keepManaged: false`）：卡片更新后没有后续交互，更新成功即
 *   `forgetManagedCard`，把 messageId 从托管表里摘掉（比如表单结算成的「已保存」
 *   卡）。
 * - **会被反复点击的列表 / 翻页 / 选择器卡**（`keepManaged: true`）：卡片更新后按钮
 *   还在，用户还会再点（翻页、返回、刷新）。必须**保留**托管登记，下一次点击才能
 *   继续走 CardKit 原地更新；否则第二次更新会失败并退化成 `im.message.patch`
 *   外加每条一次 warning 日志。
 *
 * ① 托管卡片 → CardKit 更新（带 sequence）
 * ② 否则 → 新建卡片实体并把消息内容**改指向新实体**（托管卡/老卡的唯一有效路径：
 *      直接塞裸 card JSON 既不报错也不生效），然后认领登记，后续继续原地更新
 * ③ 都不行 → 回一句 `fallbackText`，绝不静默
 */
export async function updateOrFallback(
  ctx: CommandContext,
  card: object,
  fallbackText: string,
  opts: { keepManaged?: boolean; resendWhenUnmanaged?: boolean } = {},
): Promise<void> {
  const messageId = ctx.msg.messageId;
  // 1) 首选：托管卡片走 CardKit 更新（带 sequence，能做流式 / 多次更新）。
  try {
    await updateManagedCard(ctx.channel, messageId, card);
    if (opts.keepManaged !== true) forgetManagedCard(messageId);
    return;
  } catch (err) {
    log.warn('command', 'card-settle-fallback', { messageId, err: String(err) });
  }
  // 1.b) 列表 / 分页 / 选择器这类**必定由 sendManagedCard 发出**（内容为卡片实体引用）的卡：
  //      托管更新失败 = 那张卡不是本进程建的（老卡），此时 raw patch 也不会有效（飞书接受
  //      但看不到变化），所以直接**补发一张新卡**（老卡尽力撤回），保证翻页/切换真的可见。
  if (opts.resendWhenUnmanaged === true) {
    log.info('command', 'card-resend-unmanaged', { messageId });
    const sent = await sendManagedCard(ctx.channel, ctx.msg.chatId, card, ctx.msg.messageId).catch(
      (err) => {
        log.warn('command', 'card-resend-failed', { messageId, err: String(err) });
        return undefined;
      },
    );
    if (sent !== undefined) {
      await recallMessage(ctx, messageId).catch(() => undefined);
      return;
    }
  }
  // 2) 卡片不在托管表里（最常见：上一次进程里发出的卡）时，把消息内容整体替换成新卡片。
  //    注意：这条对**流式卡/裸 JSON 内容**有效；对托管卡（内容为卡片实体引用）飞书会接受但
  //    看不到变化（要改托管卡只能用 CardKit 的 card.update，需要 card_id —— 见 updateManagedCard）。
  try {
    await ctx.channel.rawClient.im.v1.message.patch({
      path: { message_id: messageId },
      data: { content: JSON.stringify(card) },
    });
    return;
  } catch (err) {
    log.warn('command', 'card-patch-failed', { messageId, err: String(err) });
  }
  // 3) 两条都不行：至少回一句，别让点击看起来没发生。
  await reply(ctx, fallbackText);
}

export async function recallMessage(ctx: CommandContext, messageId: string): Promise<void> {
  try {
    await ctx.channel.rawClient.im.v1.message.delete({
      path: { message_id: messageId },
    });
  } catch (err) {
    // Recall failed — the old card stays in the chat with live buttons.
    // Neutralize it in place (managed cards only) instead of leaving a
    // second clickable flow stacked under the new card.
    log.warn('command', 'recall-failed', { messageId, err: String(err) });
    try {
      await updateManagedCard(ctx.channel, messageId, staleNoticeCard());
      forgetManagedCard(messageId);
    } catch {
      /* not a managed card or update also failed — nothing more to do */
    }
  }
}
