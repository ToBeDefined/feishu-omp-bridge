import { homedir } from 'node:os';
import type { CommandContext } from './index';
import { log } from '../core/logger';
import {
  assertApiOk,
  forgetManagedCard,
  sendManagedCard,
  updateManagedCard,
} from '../card/managed';
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
/** 卡片里能唯一定位「这一页」的标记（/history 的「第 N-M 个」）。没有标记的卡不校验。 */
function cardMarker(card: object): string | undefined {
  return /第 \d+-\d+ 个/.exec(JSON.stringify(card))?.[0];
}

/** 回读判定前的重试节奏：卡面刷新有短暂一致性延迟，连续试几次再判定「没渲染」。
 * 间隔可用 `CARD_VERIFY_DELAY_MS` 覆盖（测试用）。 */
const CARD_VERIFY_ATTEMPTS = 3;
function cardVerifyDelayMs(): number {
  const v = Number(process.env.CARD_VERIFY_DELAY_MS);
  return Number.isFinite(v) && v >= 0 ? v : 500;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * 卡面真的刷成 `card` 了吗？
 *
 * 实测（2026-10-13）：CardKit 的 `card.update` 会**收下但不渲染** —— HTTP 200 +
 * `code 0`、实体序号也前进，卡面却停在旧内容；同一份字节换个更大的序号重发就落地。
 * 所以更新后**必须回读**。读的是消息里真正的卡片内容：
 * `/open-apis/im/v1/messages/mget` + `card_msg_content_type=raw_card_content`。
 * 注意别用 `/im/v1/messages` —— 对实体卡它只返回「请升级客户端」占位符，而且会被判 400
 * （上一版就是这么把校验变成空操作的：400 被 catch 吞掉，永远当作已生效）。
 */
async function cardRendered(
  channel: CommandContext['channel'],
  messageId: string,
  card: object,
): Promise<boolean> {
  const marker = cardMarker(card);
  if (!marker) return true; // 无可校验标记的卡不做额外回读
  for (let attempt = 0; attempt < CARD_VERIFY_ATTEMPTS; attempt += 1) {
    if (attempt > 0) await sleep(cardVerifyDelayMs());
    try {
      const res = await channel.rawClient.request({
        method: 'GET',
        url: '/open-apis/im/v1/messages/mget',
        params: { message_ids: messageId, card_msg_content_type: 'raw_card_content' },
      });
      if (JSON.stringify(res).includes(marker)) return true;
    } catch (err) {
      // 回读失败不改变主路径（宁可少一次校验，也不要因此把好卡判定为坏卡）。
      log.warn('command', 'card-verify-failed', { messageId, err: String(err) });
      return true;
    }
  }
  return false;
}

/**
 * 点击瞬间飞书可能把卡面「钉」在用户点到的版本上，几秒内会把刚落地的更新回滚
 * （线上三次复现：+1s 回读是新页、随后回滚成旧页；无点击的 REST 场景从不复现）。
 * 确认必须等竞态窗口过去。可用 `CARD_REVERT_WINDOW_MS` 覆盖（测试用）。
 */
function cardRevertWindowMs(): number {
  const v = Number(process.env.CARD_REVERT_WINDOW_MS);
  return Number.isFinite(v) && v >= 0 ? v : 6000;
}

/** messageId → 最近一次等待确认的卡。连点时只有最新一张负责补救，旧任务直接退出。 */
const pendingSettle = new Map<string, object>();

/** 等所有延迟确认任务排空（测试与优雅关停用）。 */
let settleChain: Promise<void> = Promise.resolve();
function trackSettle(task: Promise<void>): void {
  settleChain = settleChain.then(() => task.catch(() => undefined));
}
export function cardSettlesFlushed(): Promise<void> {
  return settleChain;
}

/** 测试隔离：丢弃所有待确认登记（进行中的任务会在窗口后因登记缺失自行退出）。 */
export function clearCardSettles(): void {
  pendingSettle.clear();
}

export async function updateOrFallback(
  ctx: CommandContext,
  card: object,
  fallbackText: string,
  opts: { keepManaged?: boolean; resendWhenUnmanaged?: boolean } = {},
): Promise<void> {
  const messageId = ctx.msg.messageId;
  // 点击驱动的更新**一律换新卡**：实测（2026-10-13，/history 与 /model 双双复现）
  // 点击后对同一实体的 card.update 会被受理（code 0）随后几秒内被服务端回滚成旧版，
  // 与卡片大小、序号大小（now / now+1e6 均试过）无关；而**新发卡片从未被观察到回滚**。
  // 旧卡尽力撤回，杜绝两份可点的卡并存。
  if (ctx.fromCardAction === true) {
    const sent = await sendManagedCard(ctx.channel, ctx.msg.chatId, card, ctx.msg.messageId).catch(
      (err) => {
        log.warn('command', 'card-resend-failed', { messageId, err: String(err) });
        return undefined;
      },
    );
    if (sent !== undefined) {
      log.info('command', 'card-click-rerender', { messageId, newMessageId: sent.messageId });
      await recallMessage(ctx, messageId).catch(() => undefined);
      forgetManagedCard(messageId);
      return;
    }
    // 换卡失败（网络/限频）：退回原地更新链，聊胜于无。
  }
  pendingSettle.set(messageId, card);
  const task = settleCardAfterAck(ctx, messageId, card, fallbackText, opts);
  trackSettle(task);
  void task;
}

/**
 * ACK 之后的完整链路：原地更新（带 sequence lead）→ 竞态窗口后回读确认 →
 * 被回滚则重推 → 仍未生效则补发新卡（新卡从未被观察到回滚）。
 * 连点时只有**最新**一张卡负责补救（`pendingSettle` 里的旧任务直接退出）。
 */
async function settleCardAfterAck(
  ctx: CommandContext,
  messageId: string,
  card: object,
  fallbackText: string,
  opts: { keepManaged?: boolean; resendWhenUnmanaged?: boolean },
): Promise<void> {
  await sleep(cardAckDelayMs());
  if (pendingSettle.get(messageId) !== card) return; // 已有更新的版本接管
  try {
    await updateManagedCard(ctx.channel, messageId, card);
  } catch (err) {
    log.warn('command', 'card-settle-fallback', { messageId, err: String(err) });
    await resendOrPatch(ctx, messageId, card, fallbackText, opts);
    return;
  }
  if (cardMarker(card) === undefined) {
    // 无可校验标记的卡（绝大多数表单/终态卡）：没有可回滚的标记，按原语义收尾。
    if (opts.keepManaged !== true) forgetManagedCard(messageId);
    return;
  }
  // 立即回读没有意义：回滚发生在几秒后。等竞态窗口过去再确认。
  await sleep(cardRevertWindowMs());
  if (pendingSettle.get(messageId) !== card) return;
  try {
    if (await cardRendered(ctx.channel, messageId, card)) return;
    log.warn('command', 'card-update-reverted', { messageId });
    await updateManagedCard(ctx.channel, messageId, card);
    if (await cardRendered(ctx.channel, messageId, card)) return;
    log.warn('command', 'card-update-noop-retry', { messageId });
  } catch (err) {
    // 托管登记可能已被清掉（进程内 forget / 重启）：重推失败就换卡。
    log.warn('command', 'card-settle-fallback', { messageId, err: String(err) });
  } finally {
    pendingSettle.delete(messageId);
  }
  await resendOrPatch(ctx, messageId, card, fallbackText, opts);
}

/** ACK 等待：handler 返回（回调 ACK 发出）后再更新卡面。可用 `CARD_ACK_DELAY_MS` 覆盖（测试用）。 */
function cardAckDelayMs(): number {
  const v = Number(process.env.CARD_ACK_DELAY_MS);
  return Number.isFinite(v) && v >= 0 ? v : 800;
}

/** 同步兜底链：补发新卡（老卡尽力撤回）→ 不行再 patch 消息 → 最后回一句。 */
async function resendOrPatch(
  ctx: CommandContext,
  messageId: string,
  card: object,
  fallbackText: string,
  opts: { resendWhenUnmanaged?: boolean },
): Promise<boolean> {
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
      return true;
    }
  }
  try {
    const res = await ctx.channel.rawClient.im.v1.message.patch({
      path: { message_id: messageId },
      data: { content: JSON.stringify(card) },
    });
    assertApiOk(res, 'patch', { messageId });
    return true;
  } catch (err) {
    log.warn('command', 'card-patch-failed', { messageId, err: String(err) });
  }
  await reply(ctx, fallbackText).catch(() => undefined);
  return true;
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
