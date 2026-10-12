import type { CardActionEvent, LarkChannel, NormalizedMessage } from '@larksuiteoapi/node-sdk';
import type { AgentAdapter, AgentUiResponse } from '../agent/types';
import type { ActiveRuns } from './active-runs';
import type { ChatModeCache } from './chat-mode-cache';
import type { PendingQueue } from './pending-queue';
import { resetsContext } from './intake';
import { runCommandHandler, type CommandContext, type Controls } from '../commands';
import {
  EXPIRED_INTERACTION_TEXT,
  reply,
  updateOrFallback,
  withExpiryNotice,
} from '../commands/shared';
import { isChatAllowed, isUserAllowed } from '../config/schema';
import { log } from '../core/logger';
import type { SessionStore } from '../session/store';
import { AGENT_CALLBACK_MARKER, AGENT_MARK_ISSUED_AT, AGENT_MARK_RUN, AGENT_MARK_SCOPE } from '../card/agent-card';
import { forgetManagedCard, updateManagedCard } from '../card/managed';
import { agentSelectedCard } from '../card/templates';
import {
  isOmpUiPayload,
  ompUiRequestId,
  ompUiTitle,
  renderOmpUiResultCard,
  responseFromOmpUiAction,
} from '../card/omp-ui';
import type { WorkspaceStore } from '../workspace/store';


export interface CardDispatchDeps {
  channel: LarkChannel;
  evt: CardActionEvent;
  sessions: SessionStore;
  workspaces: WorkspaceStore;
  activeRuns: ActiveRuns;
  agent: AgentAdapter;
  controls: Controls;
  pending: PendingQueue;
  chatModeCache: ChatModeCache;
}

export async function handleCardAction(deps: CardDispatchDeps): Promise<void> {
  const value = deps.evt.action.value;
  if (!value || typeof value !== 'object') return;
  const payload = value as Record<string, unknown>;

  const operatorId = deps.evt.operator.openId;
  const chatId = deps.evt.chatId;

  // CardKit 2.0 form submits drop user-input values from action.value; they
  // arrive on raw.action.form_value. The SDK forwards the raw event when
  // includeRawEvent: true is set on the channel options.
  const raw = (deps.evt as CardActionEvent & { raw?: unknown }).raw as
    | { action?: { form_value?: Record<string, unknown> } }
    | undefined;
  const formValue = raw?.action?.form_value;

  // Resolve the click's session scope. For topic groups we need to know
  // the message's thread_id so the action targets the right topic's
  // session — look up the carrier message (the card lives on it) once.
  // Done before the access check so we know the chat mode (p2p vs group)
  // and can skip the chat allowlist for DMs.
  const { scope, threadId, mode } = await resolveScope(deps);

  // Access control. Operator must be on the same allowlists as message
  // senders. Silent drop — sending a denial card to an unauthorized user
  // just confirms the bot exists.
  if (!isUserAllowed(deps.controls.cfg, operatorId)) {
    log.info('cardAction', 'skip-not-allowed-user', {
      operator: operatorId.slice(-6),
    });
    return;
  }
  // `allowedChats` is group-only — see intakeMessage in bot/channel.ts for
  // the rationale (p2p chat_ids aren't a meaningful access boundary, the
  // user check above is authoritative for DMs).
  if (mode !== 'p2p' && !isChatAllowed(deps.controls.cfg, chatId)) {
    log.info('cardAction', 'skip-not-allowed-chat', {
      chatId: chatId.slice(-6),
    });
    return;
  }

  // 三条路径（omp-ui / agent 回调 / 命令按钮）都要走同一个「合成上下文」：
  // 用它可以发文本回执、做卡片兜底。放在分支前统一构造。
  const ctx: CommandContext = {
    channel: deps.channel,
    msg: makeFakeMsg(deps.evt, threadId, mode),
    scope,
    chatMode: mode,
    sessions: deps.sessions,
    workspaces: deps.workspaces,
    activeRuns: deps.activeRuns,
    agent: deps.agent,
    controls: deps.controls,
    formValue,
    fromCardAction: true,
  };

  if (isOmpUiPayload(payload)) {
    await respondToOmpUi(ctx, payload, formValue);
    return;
  }

  // Agent-driven callback: the button was rendered by OMP via
  // lark-cli, with `__codex_cb` set on the value. Forward the click back
  // into the scope's pending queue so OMP resumes its session and sees
  // the click as a follow-up message, with full context of what it sent.
  if (AGENT_CALLBACK_MARKER in payload) {
    // 桥自己发出的卡片带发行标记：过期 / 换了 run 就拦下，别再往新会话里注入
    // 一段莫名的 [card-click] JSON。无标记的手工卡片不校验，行为不变。
    if (bridgeMarkExpired(ctx.msg.chatId, deps, payload)) {
      log.info('cardAction', 'agent-callback-expired', { messageId: ctx.msg.messageId });
      if (rememberDuplicateNotice(ctx.msg.messageId)) {
        await reply(ctx, AGENT_BUTTON_EXPIRED_TEXT);
      }
      return;
    }
    await forwardToAgent(deps, ctx, payload, formValue);
    return;
  }

  const cmd = typeof payload.cmd === 'string' ? payload.cmd : '';
  if (!cmd) return;
  // 普通命令按钮（/history 翻页、/ps 等）也要防连点重复执行命令。用带时间窗的
  // 去重：窗口内的重复点击静默忽略，窗口外照常执行（否则合法连点会被吃掉）。
  if (!allowCommandClick(deps.evt.messageId, payload)) {
    log.info('cardAction', 'command-dedup', { cmd, scope });
    return;
  }
  log.info('cardAction', 'cmd', { cmd, scope });

  const { name, args } = resolveCardCommand(cmd, payload);

  try {
    const ok = await runCommandHandler(name ?? '', args, ctx);
    if (ok === false) {
      log.warn('cardAction', 'unknown', { cmd });
    } else if (ok === 'denied') {
      // Admin/owner command denied — it did NOT run, so its side effects
      // (like resetting the pending queue) must not fire either. But the card
      // keeps its buttons: without a receipt, tapping /ps「退出」or /every's
      // 「🗑 删除」looks like the bot is dead. `denyIfUnauthorized` hands back
      // a bare 'denied' for both gates, so the wording covers both.
      log.info('cardAction', 'denied-no-reset', { cmd, scope });
      await reply(ctx, DENIED_CLICK_NOTICE);
    } else if (resetsContext(`/${name}`, args)) {
      // 与 intake 同语义：上下文切换类命令（卡片按钮 new / ws.use）成功后
      // 丢弃旧上下文的积压消息，防止其泄入新 session。
      const dropped = deps.pending.cancel(scope);
      log.info('cardAction', 'command-reset', { scope, cmd, droppedPending: dropped.length });
    }
  } catch (err) {
    log.fail('cardAction', err, { cmd });
  }
}

async function resolveScope(
  deps: CardDispatchDeps,
): Promise<{ scope: string; threadId: string | undefined; mode: 'p2p' | 'group' | 'topic' }> {
  const chatId = deps.evt.chatId;
  const mode = await deps.chatModeCache.resolve(deps.channel, chatId);
  if (mode !== 'topic') {
    return { scope: chatId, threadId: undefined, mode };
  }
  // Topic group — need the carrier message's thread_id to compose scope.
  // One API call per click; could cache by messageId if it ever becomes hot.
  const threadId = await lookupMessageThreadId(deps.channel, deps.evt.messageId);
  if (!threadId) {
    // Fall back to plain chatId. Better to land in the chat's "default"
    // scope than fail the click silently.
    return { scope: chatId, threadId: undefined, mode };
  }
  return { scope: `${chatId}:${threadId}`, threadId, mode };
}

async function lookupMessageThreadId(
  channel: LarkChannel,
  messageId: string,
): Promise<string | undefined> {
  try {
    const r = (await channel.rawClient.im.v1.message.get({
      path: { message_id: messageId },
    })) as { data?: { items?: { thread_id?: string }[] } };
    return r?.data?.items?.[0]?.thread_id;
  } catch (err) {
    log.warn('cardAction', 'thread-id-lookup-failed', {
      messageId,
      err: err instanceof Error ? err.message : String(err),
    });
    return undefined;
  }
}

/** Cards whose click was already forwarded — one click per card, no double-send. */
const forwardedCardClicks = new Set<string>();
const FORWARDED_CLICK_CAP = 2000;

function rememberForwardedClick(messageId: string): boolean {
  if (forwardedCardClicks.has(messageId)) return false;
  if (forwardedCardClicks.size >= FORWARDED_CLICK_CAP) {
    const oldest = forwardedCardClicks.keys().next().value;
    if (oldest) forwardedCardClicks.delete(oldest);
  }
  forwardedCardClicks.add(messageId);
  return true;
}

/** 点到了管理员专属按钮、但操作者没有权限 —— 命令没跑，卡片不动，只回一句。 */
const DENIED_CLICK_NOTICE = '⚠️ 该命令仅管理员可用，本次点击未执行。';
/** 去重命中后的一次性回执（同一张卡只提示一次）。 */
const DUPLICATE_CLICK_NOTICE = '⚠️ 该交互已提交过，本次重复点击已忽略。';

/** 已经提示过「重复点击」的卡片：连点 / 双指双击会连发事件，只提示一次。 */
const duplicateClickNotices = new Set<string>();

function rememberDuplicateNotice(messageId: string): boolean {
  if (duplicateClickNotices.has(messageId)) return false;
  if (duplicateClickNotices.size >= FORWARDED_CLICK_CAP) {
    const oldest = duplicateClickNotices.keys().next().value;
    if (oldest) duplicateClickNotices.delete(oldest);
  }
  duplicateClickNotices.add(messageId);
  return true;
}

/** 去重命中：给一次轻量可见信号（同一 messageId 只给一次，不刷屏）。 */
async function noticeDuplicateClick(ctx: CommandContext): Promise<void> {
  if (!rememberDuplicateNotice(ctx.msg.messageId)) return;
  await reply(ctx, DUPLICATE_CLICK_NOTICE);
}

/** agent 卡片按钮的过期 TTL：发行超过这么久一律按「任务已结束」处理。 */
const AGENT_MARK_TTL_MS = 30 * 60_000;
/** 带队过期 / run 不匹配时的回执。 */
const AGENT_BUTTON_EXPIRED_TEXT = '⚠️ 该按钮所属任务已结束，请用最新卡片。';

/** 从 payload 里剔除桥注入的 `__omp_*` 标记，别透传给 agent。 */
function stripBridgeMarks(payload: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(payload)) {
    if (key.startsWith('__omp_')) continue;
    out[key] = value;
  }
  return out;
}

/**
 * 校验桥自己发出的 agent 卡片按钮是否仍然有效。**只对带标记的按钮生效** ——
 * 手工 lark-cli 卡片没有标记，行为不变。三种失效情形：
 * ① `__omp_iat` 超过 TTL；② `__omp_scope` 声明的作用域没有在跑的 run（旧任务结束、
 * `/new` 或 `/cd` 换了 run）；③ `__omp_run` 与当前 run token 不相等。
 */
function bridgeMarkExpired(
  chatId: string,
  deps: CardDispatchDeps,
  payload: Record<string, unknown>,
): boolean {
  const iat = payload[AGENT_MARK_ISSUED_AT];
  if (typeof iat === 'number' && (!Number.isFinite(iat) || Date.now() - iat > AGENT_MARK_TTL_MS)) {
    return true;
  }
  const claimed = payload[AGENT_MARK_SCOPE];
  if (typeof claimed !== 'string' || claimed === '') return false;
  // 声明的作用域必须属于本次点击的会话（防伪造去污染别的会话的 run）。
  if (claimed !== chatId && !claimed.startsWith(`${chatId}:`)) return true;
  // 作用域必须仍有一个在跑的 run；否则这张卡属于已经结束的任务。
  if (!deps.activeRuns.has(claimed)) return true;
  const run = payload[AGENT_MARK_RUN];
  if (typeof run !== 'string' || !run) return false;
  return deps.activeRuns.getRunToken?.(claimed) !== run;
}

/** 普通命令按钮的时间窗去重：同一张卡、同一个按钮在窗口内的重复点击静默忽略。
 * 必须带时间窗 —— 用户合法地连点「下一页」不能被吃掉。 */
const COMMAND_CLICK_WINDOW_MS = 2_000;
const COMMAND_CLICK_CAP = 2_000;
const recentCommandClicks = new Map<string, number>();

function allowCommandClick(messageId: string, payload: Record<string, unknown>): boolean {
  const key = `${messageId}:${JSON.stringify(payload)}`;
  const now = Date.now();
  const last = recentCommandClicks.get(key);
  if (last !== undefined && now - last < COMMAND_CLICK_WINDOW_MS) return false;
  if (recentCommandClicks.size >= COMMAND_CLICK_CAP) {
    const oldest = recentCommandClicks.keys().next().value;
    if (oldest !== undefined) recentCommandClicks.delete(oldest);
  }
  recentCommandClicks.set(key, now);
  return true;
}

async function forwardToAgent(
  deps: CardDispatchDeps,
  ctx: CommandContext,
  payload: Record<string, unknown>,
  formValue: Record<string, unknown> | undefined,
): Promise<void> {
  // One click per card: a second tap (double-tap, or an un-updated card)
  // must not forward the same choice twice — but say so once, or the tap
  // looks like it did nothing at all.
  if (!rememberForwardedClick(ctx.msg.messageId)) {
    log.info('cardAction', 'duplicate-click', { messageId: ctx.msg.messageId });
    await noticeDuplicateClick(ctx);
    return;
  }

  // Strip the callback marker and the bridge's `__omp_*` marks so OMP only
  // sees the meaningful fields it set.
  const { [AGENT_CALLBACK_MARKER]: _marker, ...agentPayload } = stripBridgeMarks(payload);
  const merged = formValue ? { ...agentPayload, form_value: formValue } : agentPayload;
  log.info('cardAction', 'forward-agent', {
    scope: ctx.scope,
    payload: JSON.stringify(merged).slice(0, 200),
  });

  // Reflect the choice on the card so the buttons stop being re-clickable.
  // Bridge-managed cards (feishu_send_card) update in place; externally
  // sent cards (lark-cli) aren't managed, so the update silently no-ops —
  // those cards belong to whoever sent them, so no fallback patch here.
  const label = typeof deps.evt.action.name === 'string' && deps.evt.action.name.trim()
    ? deps.evt.action.name.trim()
    : undefined;
  if (label) {
    await updateManagedCard(deps.channel, deps.evt.messageId, agentSelectedCard(label)).catch(() => {
      /* unmanaged card — nothing to update */
    });
    forgetManagedCard(deps.evt.messageId);
  }

  const synthetic: NormalizedMessage = {
    messageId: ctx.msg.messageId,
    chatId: ctx.msg.chatId,
    chatType: ctx.msg.chatType,
    threadId: ctx.msg.threadId,
    senderId: ctx.msg.senderId,
    senderName: ctx.msg.senderName,
    content: `[card-click] ${JSON.stringify(merged)}`,
    rawContentType: 'card_action',
    resources: [],
    mentions: [],
    mentionAll: false,
    mentionedBot: false,
    createTime: Date.now(),
  };
  deps.pending.push(ctx.scope, synthetic);
}

/** 空提交（select 未选 / input 留空直接点提交）的可见提示。 */
const EMPTY_SUBMIT_NOTICE = '⚠️ 请先选择 / 填写后再提交。';

/** 结果卡的回显文本：confirm → 「确认 / 否」；submit → 用户提交的值。 */
function echoOf(response: AgentUiResponse | undefined): string | undefined {
  if (!response) return undefined;
  if ('value' in response) return response.value;
  if ('confirmed' in response) return response.confirmed ? '确认' : '否';
  return undefined;
}

async function respondToOmpUi(
  ctx: CommandContext,
  payload: Record<string, unknown>,
  formValue: Record<string, unknown> | undefined,
): Promise<void> {
  const requestId = ompUiRequestId(payload);
  const title = ompUiTitle(payload);
  const response = responseFromOmpUiAction(payload, formValue);

  // 空提交不能当成交付给 OMP（否则 agent 收到空串，界面还显示「已提交」）：
  // 不调用 respondToUi，回一句提示，并保持原卡片可继续操作 —— 因此**不**消费
  // 一次性去重、也**不**更新卡片。
  if (response && 'value' in response && response.value.trim() === '') {
    log.info('cardAction', 'omp-ui-empty-submit', { messageId: ctx.msg.messageId, requestId });
    await reply(ctx, EMPTY_SUBMIT_NOTICE);
    return;
  }

  // One click per card, same as the agent-callback path: a double-tap (or an
  // un-updated card) must not deliver two UI responses to OMP.
  if (!rememberForwardedClick(ctx.msg.messageId)) {
    log.info('cardAction', 'duplicate-click', { messageId: ctx.msg.messageId, path: 'omp-ui' });
    await noticeDuplicateClick(ctx);
    return;
  }

  // Only trust a payload-supplied scope when it provably belongs to the
  // clicked chat — the plain chatId, or a topic scope `chatId:threadId`.
  // A forged value could otherwise answer another chat's pending UI request.
  const chatId = ctx.msg.chatId;
  const claimed = typeof payload.scope === 'string' ? payload.scope : '';
  const targetScope = claimed === chatId || claimed.startsWith(`${chatId}:`) ? claimed : ctx.scope;
  const submitted = Boolean(requestId && response && ctx.activeRuns.respondToUi(targetScope, requestId, response));
  const status = submitted
    ? response && 'cancelled' in response
      ? 'cancelled'
      : 'submitted'
    : 'unavailable';

  log.info('cardAction', 'omp-ui', { scope: targetScope, requestId, submitted, status });
  const resultCard = renderOmpUiResultCard(title, status, submitted ? echoOf(response) : undefined);
  try {
    await updateManagedCard(ctx.channel, ctx.msg.messageId, resultCard);
  } catch (err) {
    // 卡片不在托管表里（重启前发出的老卡片、bridge 之外发的卡片）→ CardKit
    // 更新必然失败。此时只记日志的话，用户看到的就是「点了没反应」，而且这张
    // 卡再点还会被去重吞掉。兜底：patch 成终态卡（按钮消失 + 已过期说明），
    // patch 也失败就回一句 —— 但绝不再动 OMP 那边，回答已经送出去了。
    log.fail('cardAction', err, { step: 'omp-ui-update', requestId });
    await updateOrFallback(ctx, withExpiryNotice(resultCard), EXPIRED_INTERACTION_TEXT);
  } finally {
    forgetManagedCard(ctx.msg.messageId);
  }
}

/** Turn a button payload like {cmd:'ws.use', name:'proj-a'} into the arg
 * string the text-command handler expects: 'use proj-a'. Accepts `arg`
 * (preferred, generic) or `name` (legacy ws cards). */
function composeArgs(sub: string, payload: Record<string, unknown>): string {
  if (!sub) return '';
  const arg =
    (typeof payload.arg === 'string' && payload.arg) ||
    (typeof payload.name === 'string' && payload.name) ||
    '';
  return arg ? `${sub} ${arg}` : sub;
}

/**
 * Map a button `cmd` + payload to the text command it invokes:
 * `{cmd:'history.page', arg:'all 8'}` → `('/history', 'page all 8')`,
 * i.e. the same shape a user would type. Exported so the `.`-to-subcommand
 * contract is unit-testable without a live channel.
 */
export function resolveCardCommand(
  cmd: string,
  payload: Record<string, unknown>,
): { name: string; args: string } {
  const [name, ...rest] = cmd.split('.');
  return { name: name ?? '', args: composeArgs(rest.join(' '), payload) };
}

function makeFakeMsg(
  evt: CardActionEvent,
  threadId: string | undefined,
  mode: 'p2p' | 'group' | 'topic',
): NormalizedMessage {
  return {
    messageId: evt.messageId,
    chatId: evt.chatId,
    chatType: mode === 'p2p' ? 'p2p' : 'group',
    threadId,
    senderId: evt.operator.openId,
    senderName: evt.operator.name,
    content: '',
    rawContentType: 'interactive',
    resources: [],
    mentions: [],
    mentionAll: false,
    mentionedBot: false,
    createTime: Date.now(),
  };
}
