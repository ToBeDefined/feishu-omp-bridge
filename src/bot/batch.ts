import type { LarkChannel, NormalizedMessage } from '@larksuiteoapi/node-sdk';
import type { AgentAdapter, AgentEvent, AgentUiRequest } from '../agent/types';
import type { ActiveRuns, RunClaim, RunHandle } from './active-runs';
import {
  forgetManagedCard,
  forgetStreamingCard,
  patchCardWithRetry,
  rememberStreamingCard,
  sendManagedCard,
  snapshotStreamingCard,
  updateManagedCard,
} from '../card/managed';
import { createFeishuHostIntegration } from './feishu-host';
import { renderOmpUiRequestCard, renderOmpUiResultCard } from '../card/omp-ui';
import { renderCard } from '../card/run-renderer';
import { splitByTableBudget } from '../card/tables';
import {
  CARD_UPDATE_MIN_INTERVAL_MS,
  carryOverBlocks,
  coalesceLatest,
  cardExceedsBudget,
  fallbackCard,
  fallbackContent,
  splitByByteBudget,
} from '../card/pagination';
import {
  finalizeIfRunning,
  initialState,
  markIdleTimeout,
  markInterrupted,
  reduce,
  type Block,
  type RunState,
} from '../card/run-state';
import { renderText, splitText } from '../card/text-renderer';
import type { Controls } from '../commands';
import {
  getAgentStopGraceMs,
  getMessageReplyMode,
  getOmpModel,
  getOmpThinking,
  getRunIdleTimeoutMs,
  getShowToolCalls,
  isChatAllowed,
} from '../config/schema';
import { resolveConversationCwd } from '../session/current-cwd';
import { log } from '../core/logger';
import { attachTextExtracts, type MediaCache } from '../media/cache';
import { attachTranscripts, mediaFailureNotice } from '../media/transcribe';
import type { SessionStore } from '../session/store';
import type { WorkspaceStore } from '../workspace/store';
import { recordModelUse } from '../session/model-history';
import type { ChatMode } from './chat-mode-cache';
import { buildPrompt } from './prompt';
import type { ProcessPool } from './process-pool';
import { fetchQuotedContext, type QuotedContext } from './quote';

export interface RunBatchDeps {
  channel: LarkChannel;
  agent: AgentAdapter;
  sessions: SessionStore;
  workspaces: WorkspaceStore;
  activeRuns: ActiveRuns;
  media: MediaCache;
  batch: NormalizedMessage[];
  controls: Controls;
  scope: string;
  mode: ChatMode;
  /** Slot reserved by the caller before its first await. */
  claim?: RunClaim;
}

export interface AgentStreamHooks {
  onUiRequest(request: AgentUiRequest): Promise<void>;
  onUiCancel(targetId: string): Promise<void>;
}

interface UiCardEntry {
  messageId: string;
  title: string;
  /** 交互卡的超时截止时刻（epoch ms）。倒计时续期与重渲染都读它，避免每拍
   *  重新推算 deadline 累积漂移；无超时的请求不写这个字段。 */
  deadline?: number;
}

/**
 * 交互卡剩余时间的重渲染节拍。5s 一拍：显示粒度为整数秒，一拍一变；间隔刻意
 * 远大于单消息更新下限 `CARD_UPDATE_MIN_INTERVAL_MS`（300ms），因此不会每个
 * tick 都 patch —— 只有整数秒变化时才写一次。
 */
const UI_COUNTDOWN_TICK_MS = 5000;

/**
 * Bridge OMP's extension UI requests to interactive Feishu cards. Shared by
 * the interactive batch and the scheduled-prompt path, so a scheduled run's
 * confirm/select is answerable instead of stalling the run forever.
 *
 * `replyToMessageId` threads the card under the user's message; a scheduled
 * run has none and posts at chat level.
 *
 * Exported for tests: it is the only place that turns an OMP UI request into a
 * Feishu card, and its failure path (see `onUiRequest`'s catch) is a
 * user-visible behaviour worth pinning down.
 */
export function createUiHooks(opts: {
  channel: LarkChannel;
  chatId: string;
  scope: string;
  replyToMessageId: string | undefined;
  activeRuns: ActiveRuns;
  cards: Map<string, UiCardEntry>;
  /**
   * 该 UI 请求是否还在等答案（用户回答 / OMP 撤回后为 false）。倒计时每一拍用它
   * 决定是否继续续期 —— `ui_cancel` 走的是 streamEvents 直删 pending 的路径，
   * 不经过 `respondToUi`，光靠定时器清理挡不住「醒来再 patch 一张结果卡」。
   * 不提供时退化为只靠 active-runs 的定时器清理。
   */
  isPending?: (requestId: string) => boolean;
}): AgentStreamHooks {
  const { channel, chatId, scope, replyToMessageId, activeRuns, cards, isPending } = opts;

  /** 剩余整秒（向上取整）；纯计算，时钟只在这里读。 */
  const secondsLeft = (deadline: number): number =>
    Math.max(0, Math.ceil((deadline - Date.now()) / 1000));

  /** 渲染请求卡：剩余秒数由这里算好传进纯函数构建器。 */
  const renderRequest = (request: AgentUiRequest, remaining?: number): object =>
    remaining === undefined
      ? renderOmpUiRequestCard(request, scope)
      : renderOmpUiRequestCard(request, scope, { remainingSeconds: remaining });

  /**
   * 交互卡倒计时。**复用 active-runs 里同一个 UI 超时定时器**（`armUiTimeout`）：
   * 每一拍醒来先同步续下一拍、再重渲染剩余秒数；只有到点时才真正走超时取消。
   * 用户回包时 `respondToUi` 会清掉这个定时器，倒计时自然终止；`isPending` 再兜
   * 一层 `ui_cancel` 路径。整条链只经手 active-runs 那一个定时器，不新造机制。
   */
  const armCountdown = (request: AgentUiRequest, messageId: string, deadline: number): void => {
    let lastShown = secondsLeft(deadline);
    const tick = (): void => {
      // 已被回答 / 被 OMP 撤回：链条到此为止（绝不再刷回请求卡）。
      if (isPending && !isPending(request.id)) return;
      const remainingMs = deadline - Date.now();
      if (remainingMs <= 0) {
        // 到点：沿用既有行为 —— 回包 cancelled、卡改终态、不再续期。
        // respondToUi 返回 false 说明请求已 settle，这时绝不能再补一张
        // timed_out 卡盖掉用户刚看到的结果卡。
        if (!activeRuns.respondToUi(scope, request.id, { cancelled: true, timedOut: true })) return;
        updateManagedCard(channel, messageId, renderOmpUiResultCard(request.title, 'timed_out'))
          .catch(() => {
            /* card update is best-effort */
          })
          .finally(() => forgetManagedCard(messageId));
        cards.delete(request.id);
        return;
      }
      // 先续拍（同步）再渲染：用户若在这之后回包，respondToUi 会清掉新定时器。
      // 间隔取 min(节拍, 剩余)，到点仍落在原 deadline 上 —— 不因倒计时延长超时。
      activeRuns.armUiTimeout(scope, request.id, Math.min(UI_COUNTDOWN_TICK_MS, remainingMs), tick);
      const remaining = secondsLeft(deadline);
      if (remaining === lastShown) return;
      lastShown = remaining;
      updateManagedCard(channel, messageId, renderRequest(request, remaining)).catch(() => {
        /* card update is best-effort */
      });
    };
    activeRuns.armUiTimeout(
      scope,
      request.id,
      Math.min(UI_COUNTDOWN_TICK_MS, Math.max(0, deadline - Date.now())),
      tick,
    );
  };

  return {
    async onUiRequest(request) {
      try {
        const existing = cards.get(request.id);
        if (existing) {
          const remaining =
            existing.deadline === undefined ? undefined : secondsLeft(existing.deadline);
          await updateManagedCard(channel, existing.messageId, renderRequest(request, remaining));
          existing.title = request.title;
          return;
        }
        const timeout = 'timeout' in request ? request.timeout : undefined;
        const deadline = timeout !== undefined && timeout > 0 ? Date.now() + timeout : undefined;
        const sent = await sendManagedCard(
          channel,
          chatId,
          renderRequest(request, deadline === undefined ? undefined : secondsLeft(deadline)),
          replyToMessageId,
          { track: true, kind: 'form' },
        );
        cards.set(request.id, {
          messageId: sent.messageId,
          title: request.title,
          ...(deadline === undefined ? {} : { deadline }),
        });
        // Auto-cancel on timeout: while OMP waits for UI input the idle
        // watchdog is paused, so an unanswered prompt would hang the run
        // forever. The timer is cancelled in ActiveRuns.respondToUi when the
        // user answers first; `armCountdown` re-arms the same timer every tick
        // so the card can show the remaining seconds.
        if (deadline !== undefined) armCountdown(request, sent.messageId, deadline);
      } catch (err) {
        // The request is already registered as outstanding, and an outstanding
        // request pauses the idle watchdog. With no card on screen and no timer
        // armed, the run (and its OMP child) would wait for an answer that can
        // never arrive — answer it as cancelled so the agent moves on.
        log.fail('omp-ui', err, { scope, requestId: request.id, method: request.method });
        activeRuns.respondToUi(scope, request.id, { cancelled: true });
        activeRuns.dropUiRequest(scope, request.id);
        // 用户侧不能静默：卡片没出现，OMP 却已经按「取消」继续跑 —— 用户只会看到
        // 自己的消息石沉大海，或一个他从未见过的确认框被跳过。发一条明确提示。
        // 发送本身也可能失败（网络正是出错的原因），因此只记日志。
        await channel
          .send(
            chatId,
            { markdown: '⚠️ 交互卡片发送失败，已按取消处理' },
            replyToMessageId ? { replyTo: replyToMessageId } : {},
          )
          .catch((notifyErr) =>
            log.fail('omp-ui', notifyErr, { scope, requestId: request.id, step: 'notify' }),
          );
      }
    },
    async onUiCancel(targetId) {
      const entry = cards.get(targetId);
      if (!entry) return;
      cards.delete(targetId);
      // OMP 撤回这个请求走的是 streamEvents 直删 pending 的路径，不经过
      // respondToUi，因此没人替它清掉倒计时定时器 —— 这里自己收，否则下一拍醒来
      // 还要 patch 一次结果卡。（无定时器的请求里这一步是空操作。）
      activeRuns.dropUiRequest(scope, targetId);
      try {
        await updateManagedCard(channel, entry.messageId, renderOmpUiResultCard(entry.title, 'cancelled'));
      } catch (err) {
        log.fail('omp-ui', err, { scope, requestId: targetId, step: 'cancel-update' });
      } finally {
        forgetManagedCard(entry.messageId);
      }
    },
  };
}

export async function runAgentBatch(deps: RunBatchDeps): Promise<void> {
  await runBatchOnce(deps, false);
}

/**
 * One attempt at a batch. Re-entered once (with `retriedStaleSession`) when
 * the run died because OMP could not resume the stored session id.
 */
async function runBatchOnce(deps: RunBatchDeps, retriedStaleSession: boolean): Promise<void> {
  const {
    channel,
    agent,
    sessions,
    workspaces,
    activeRuns,
    media,
    batch,
    controls,
    scope,
    mode,
    claim,
  } = deps;
  if (batch.length === 0) return;
  const firstMsg = batch[0];
  const lastMsg = batch[batch.length - 1];
  if (!firstMsg || !lastMsg) return;

  const chatId = firstMsg.chatId;
  const threadId = firstMsg.threadId;

  const resourceItems = batch.flatMap((m) =>
    m.resources.map((r) => ({ messageId: m.messageId, resource: r })),
  );
  const attachments = await media.resolve(chatId, resourceItems);
  if (attachments.length > 0) {
    log.info('media', 'resolved', { count: attachments.length });
  }
  // Resources that never made it to disk (expired file_key, 403, disk full).
  // Their `![name](file_key)` marker must NOT be stripped from the user's text
  // and the agent must be told they exist, or a dropped attachment looks
  // exactly like the user never sent one. Stickers are skipped on purpose —
  // reporting those as failures would be noise.
  const resolvedKeys = new Set(attachments.map((a) => a.fileKey).filter(Boolean));
  const unresolvedFileKeys = [
    ...new Set(
      resourceItems
        .filter((item) => item.resource.type !== 'sticker')
        .map((item) => item.resource.fileKey)
        .filter((key) => !resolvedKeys.has(key)),
    ),
  ];
  if (unresolvedFileKeys.length > 0) {
    log.warn('media', 'unresolved', { count: unresolvedFileKeys.length });
  }
  // Voice messages: transcribe to text so the agent can read the content.
  const transcriptFailures = await attachTranscripts(channel, attachments);
  // Text-like files: inline their content so the agent sees it directly.
  await attachTextExtracts(attachments);
  const imagePaths = attachments
    .filter((attachment) => attachment.kind === 'image')
    .map((attachment) => attachment.path);

  // Collect any reply-quote targets in the batch. Dedup so the same target
  // quoted by multiple messages in one batch only fetches once. Filter out
  // ids that are themselves in the batch — those are already in the prompt.
  const batchIds = new Set(batch.map((m) => m.messageId));
  const quoteTargets = [
    ...new Set(
      batch
        .map((m) => m.replyToMessageId)
        .filter((id): id is string => Boolean(id) && !batchIds.has(id!)),
    ),
  ];
  const quotes = (
    await Promise.all(quoteTargets.map((id) => fetchQuotedContext(channel, id)))
  ).filter((q): q is QuotedContext => Boolean(q));
  if (quotes.length > 0) {
    log.info('quote', 'fetched', { count: quotes.length });
  }

  const prompt = buildPrompt(batch, attachments, quotes, unresolvedFileKeys);
  log.info('prompt', 'built', { promptChars: prompt.length, quotes: quotes.length });

  // 会话优先：有当前会话就在**它自己的**目录里续它（cwd 由会话携带）。
  const { cwd, sessionId: resumeFrom } = await resolveConversationCwd(workspaces, sessions, scope);
  if (resumeFrom) {
    log.info('session', 'resume', { sessionId: resumeFrom, cwd });
  } else {
    const current = sessions.sessionFor(scope);
    // 只有「有当前会话、但它的目录已经不可用」（被删/改名）才需要丢掉指针：
    // `/new`、`/cd`、`/ws use` 之后本来就没有当前会话，不能顺手抹掉。
    if (current !== undefined && current.cwd !== cwd) {
      log.info('session', 'stale-cleared', { staleCwd: current.cwd, newCwd: cwd });
      // 目录换了 → 这次跑的必然是新 OMP 会话 = 新对话。
      sessions.startNew(scope);
    } else {
      log.info('session', 'fresh', { cwd });
    }
  }

  const feishuHost = createFeishuHostIntegration(channel, {
    scope,
    chatId,
    threadId,
    replyToMessageId: lastMsg.messageId,
    cwd,
    activeRuns,
    // The tools accept an explicit chatId from the agent; without this the
    // model can write into (and read) chats the operator excluded.
    isChatAllowed: (target) => isChatAllowed(controls.cfg, target),
  });

  const runModel = getOmpModel(controls.cfg);
  if (runModel) {
    await recordModelUse(runModel).catch(() => {});
  }
  const run = agent.run({
    prompt,
    sessionId: resumeFrom,
    cwd,
    model: runModel,
    thinking: getOmpThinking(controls.cfg),
    imagePaths,
    stopGraceMs: getAgentStopGraceMs(controls.cfg),
    hostTools: feishuHost.tools,
    hostUriSchemes: feishuHost.uriSchemes,
  });
  const handle = activeRuns.register(scope, run, claim);
  if (!handle) {
    // Defensive: the slot was taken between claim and register. Never clobber
    // the live handle — kill this child instead of running two agents against
    // one session jsonl. The caller releases the claim.
    log.warn('runs', 'register-failed', { scope, batchSize: batch.length });
    await run.stop().catch(() => {});
    return;
  }

  // Resolve idle-timeout for this run: scope override (on SessionEntry) wins
  // over global default (preferences). 0 / undefined = no watchdog.
  const scopeOverride = sessions.getIdleTimeoutMinutes(scope);
  const idleTimeoutMs =
    scopeOverride !== undefined
      ? scopeOverride > 0
        ? scopeOverride * 60_000
        : undefined
      : getRunIdleTimeoutMs(controls.cfg);
  if (idleTimeoutMs) {
    log.info('flush', 'idle-watchdog', { idleTimeoutMs });
  }

  const replyMode = getMessageReplyMode(controls.cfg);
  log.info('flush', 'reply-mode', { mode: replyMode });

  // Re-read prefs on every flush so toggling /config mid-stream takes
  // effect immediately. Cheap object lookups, no allocation when on.
  const filter = (state: RunState): RunState => filterToolBlocks(state, controls);

  // For topic groups: thread the reply so it lands in the same topic as the
  // user's message. Otherwise the SDK posts at top level and the user's
  // topic discussion breaks visually.
  const sendOpts = {
    replyTo: lastMsg.messageId,
    ...(mode === 'topic' && threadId ? { replyInThread: true } : {}),
  };

  // 媒体 best-effort 失败的可见回执：转写失败 / 附件下载失败以前完全静默 ——
  // 用户只看到 Typing，之后可能收到一个答非所问的回答，却不知道语音被忽略了。
  // 只失败才发（成功的语音不发），且提示自身 catch 掉：一条提示绝不能拖垮主流程。
  const mediaNotice = mediaFailureNotice({
    transcriptFailures,
    unresolvedDownloads: unresolvedFileKeys.length,
  });
  if (mediaNotice) {
    await channel
      .send(chatId, { markdown: mediaNotice }, sendOpts)
      .catch((err) => log.fail('media', err, { scope, step: 'failure-notice' }));
  }

  const uiCards = new Map<string, UiCardEntry>();
  const uiHooks = createUiHooks({
    channel,
    chatId,
    scope,
    replyToMessageId: lastMsg.messageId,
    activeRuns,
    cards: uiCards,
    isPending: (requestId) => handle.pendingUiRequests.has(requestId),
  });

  try {
    if (replyMode === 'card') {
      await streamCardPages(
        channel,
        chatId,
        sendOpts,
        handle,
        sessions,
        scope,
        cwd,
        idleTimeoutMs,
        uiHooks,
        filter,
      );
    } else if (replyMode === 'markdown') {
      // 这里不做分段：markdown 流式回复自带 rollover —— SDK 在单个元素超过
      // `streamMaxElementChars` 时会把内容切成新卡继续（见 SDK 的
      // MarkdownStreamControllerImpl），超长内容不会整条被拒。
      await channel.stream(
        chatId,
        {
          markdown: async (ctrl) => {
            const q = coalesceLatest((text: string) => ctrl.setContent(text));
            await processAgentStream(handle, sessions, scope, cwd, idleTimeoutMs, async (state) => {
              q.push(renderText(filter(state)));
            }, uiHooks);
            await q.flush();
          },
        },
        sendOpts,
      );
    } else {
      // text mode: drain the agent stream without sending anything during
      // the run, then post the final rendered text once as a plain markdown
      // (msg_type=post) message — no card, no streaming, no typewriter.
      let finalState: RunState = initialState;
      await processAgentStream(handle, sessions, scope, cwd, idleTimeoutMs, async (state) => {
        finalState = state;
      }, uiHooks);
      const body = renderText(filter(finalState));
      if (body.trim()) {
        await sendTextPages(channel, chatId, sendOpts, body);
      }
    }
  } catch (err) {
    log.fail('stream', err);
    // Stream blew up mid-run (card update network error, producer throw…):
    // processAgentStream's tail reap never ran, and the OMP child is a
    // detached spawn whose stdin stays open — it would hang forever,
    // surviving even a daemon restart. Stop it here. No-op if already dead.
    await run.stop().catch(() => {});
  } finally {
    for (const { messageId } of uiCards.values()) forgetManagedCard(messageId);
    uiCards.clear();
    activeRuns.unregister(scope, run);
  }

  // OMP assigns a session id on the first turn but only persists the session
  // file once that turn succeeds — a first-turn failure (missing model
  // credentials, abort) leaves the bridge holding an id that `--resume`
  // rejects. Since OMP 18.6.3, a persisted session whose saved model is gone
  // also fails every resume ("Could not restore model"). Either way the chat
  // is bricked: every later message dies on the same startup error. Drop the
  // dead id and replay the batch once.
  if (resumeFrom && !retriedStaleSession && run.staleSession) {
    log.warn('session', 'stale-cleared', { sessionId: resumeFrom, cwd });
    // 这段会话已经续不上了（文件没落盘 / model 丢失）：重放会在新 OMP 会话里
    // 跑，也就是开一段新对话；scope 的空闲超时等偏好不受影响。
    sessions.startNew(scope);
    // The first attempt's claim was consumed by its register, and a /compact
    // deferred during the run may have taken the slot meanwhile. Reserve again
    // — if the slot is taken, the replay must not start a second agent on the
    // session the compactor is already working on.
    const retryClaim = activeRuns.claim(scope);
    if (!retryClaim) {
      log.warn('session', 'retry-skipped-busy', { scope });
      return;
    }
    try {
      await runBatchOnce({ ...deps, claim: retryClaim }, true);
    } finally {
      activeRuns.releaseClaim(retryClaim);
    }
  }
}

/**
 * Cross-page state for driving the agent's event stream. Card reply mode
 * paginates (a single card can't hold an unbounded number of tool panels),
 * so the event iterator, accumulated RunState, and idle watchdog must
 * survive across pages. Markdown/text modes use it as a single page.
 */
interface StreamSession {
  state: RunState;
  iter: AsyncIterator<AgentEvent>;
  idleFired: boolean;
  timer: NodeJS.Timeout | undefined;
  inFlightTools: Set<string>;
  armOrPauseIdle: () => void;
  /** True once events are exhausted or a terminal state was reached. */
  done: boolean;
  /** Content a closed page could not carry: it overflowed the table budget
   *  (see `splitByTableBudget`) and is prepended to the next page. */
  carry: Block[];
}

function createStreamSession(handle: RunHandle, idleTimeoutMs: number | undefined): StreamSession {
  const session: StreamSession = {
    // 起跑时间戳：卡上的「用时」脚注从这一刻算起。
    state: { ...initialState, startedAt: Date.now() },
    iter: handle.run.events[Symbol.asyncIterator](),
    idleFired: false,
    timer: undefined,
    inFlightTools: new Set(),
    armOrPauseIdle: () => {},
    done: false,
    carry: [],
  };
  // Idle watchdog: OMP going silent for `idleTimeoutMs` is treated as
  // "presumed hung", we stop() and surface a timeout marker on the card.
  // Paused while a tool or UI request is in flight (long-running lark-cli
  // OAuth, native UI prompts), re-armed when the in-flight set drains.
  session.armOrPauseIdle = (): void => {
    if (!idleTimeoutMs) return;
    clearTimeout(session.timer);
    session.timer = undefined;
    if (session.inFlightTools.size > 0 || handle.pendingUiRequests.size > 0) return;
    session.timer = setTimeout(() => {
      session.idleFired = true;
      handle.interrupted = true;
      log.warn('agent', 'idle-timeout', { idleTimeoutMs });
      void handle.run.stop().catch(() => {
        /* stop errors are non-fatal */
      });
    }, idleTimeoutMs);
  };
  handle.onUiSettled = session.armOrPauseIdle;
  session.armOrPauseIdle();
  return session;
}

/**
 * Drain events into the session's state until the stream ends, a terminal
 * state is reached, or `onState` returns false (page overflow — the caller
 * paginates and calls again). `onState` sees every reduced state and may
 * flush it.
 */
async function streamEvents(
  session: StreamSession,
  handle: RunHandle,
  sessions: SessionStore,
  scope: string,
  cwd: string,
  hooks: AgentStreamHooks | undefined,
  onState: (state: RunState) => Promise<boolean>,
): Promise<void> {
  while (!session.done) {
    const { done, value } = await session.iter.next();
    if (done) {
      session.done = true;
      return;
    }
    const evt = value;
    if (handle.interrupted) {
      session.done = true;
      return;
    }

    // Track tool/UI flight before re-arming the idle timer so the arm step
    // sees the correct set size.
    if (evt.type === 'tool_use') {
      session.inFlightTools.add(evt.id);
    } else if (evt.type === 'tool_result') {
      session.inFlightTools.delete(evt.id);
    } else if (evt.type === 'ui_request') {
      handle.pendingUiRequests.add(evt.request.id);
    } else if (evt.type === 'ui_cancel') {
      handle.pendingUiRequests.delete(evt.targetId);
    }
    session.armOrPauseIdle();

    if (evt.type === 'system') {
      if (evt.sessionId) {
        const effectiveCwd = evt.cwd ?? cwd;
        sessions.bind(scope, evt.sessionId, effectiveCwd);
        log.info('session', 'set', { sessionId: evt.sessionId });
      }
      continue;
    }
    if (evt.type === 'usage') {
      // 用量不再只写日志：并进运行态，卡的底部脚注才有 token / 费用可显示。
      // 它不改变任何正文，所以**不单独触发一次 patch** —— 下一个事件的 patch
      // 会顺带把它带上；流在 usage 之后直接结束的话，收尾的终态渲染也读得到。
      session.state = reduce(session.state, evt);
      if (evt.costUsd !== undefined) {
        log.info('agent', 'usage', { costUsd: Number(evt.costUsd.toFixed(4)) });
      }
      continue;
    }
    if (evt.type === 'ui_request') {
      await hooks?.onUiRequest(evt.request);
    } else if (evt.type === 'ui_cancel') {
      await hooks?.onUiCancel(evt.targetId);
    }

    session.state = reduce(session.state, evt);
    const keepGoing = await onState(session.state);
    if (!keepGoing) return; // overflow — session.done stays false, caller paginates
    // Stop as soon as we have a terminal state. Some OMP RPC runs may leave
    // stdout open briefly after agent_end, which would leave the iterator
    // waiting forever otherwise.
    if (session.state.terminal !== 'running') {
      session.done = true;
      return;
    }
  }
}

/**
 * Resolve a run's working directory: the chat's recorded cwd, verified to
 * exist (a deleted/renamed directory would make every omp spawn ENOENT).
 * Falls back to $HOME and repairs the stored workspace. Shared by the
 * normal batch and scheduled-prompt paths.
 */

/** Reap the OMP subprocess after the stream ends (shared by all modes). */
async function reapRun(handle: RunHandle): Promise<void> {
  if (handle.interrupted) {
    // Interrupted (user /stop, idle watchdog, disconnect): stop() was already
    // fire-and-forgotten by whoever set handle.interrupted; this awaits it.
    await handle.run.stop();
  } else {
    // Natural done: agent_end can arrive before OMP has fully closed stdout.
    // Wait it out so the run exits with code 0; SIGTERM only as a safety net.
    const exited = await handle.run.waitForExit(POST_DONE_EXIT_GRACE_MS);
    if (!exited) {
      log.warn('agent', 'post-done-timeout', { graceMs: POST_DONE_EXIT_GRACE_MS });
      await handle.run.stop();
    }
  }
}

/** Compute the final (non-running) state, preferring a real terminal. */
function finalizeSessionState(
  session: StreamSession,
  handle: RunHandle,
  idleTimeoutMs: number | undefined,
): RunState {
  let state = session.state;
  if (state.terminal !== 'running') return state;
  if (session.idleFired) {
    state = markIdleTimeout(state, Math.round(idleTimeoutMs! / 60_000));
  } else if (handle.interrupted) {
    state = markInterrupted(state);
  } else {
    state = finalizeIfRunning(state);
  }
  return state;
}

/**
 * Drive the agent's event stream into a stateful RunState, calling `flush`
 * on every state transition. Single-page — used by markdown and text modes
 * (card mode paginates via streamCardPages).
 */
async function processAgentStream(
  handle: RunHandle,
  sessions: SessionStore,
  scope: string,
  cwd: string,
  idleTimeoutMs: number | undefined,
  flush: (state: RunState) => Promise<void>,
  hooks?: AgentStreamHooks,
): Promise<void> {
  const session = createStreamSession(handle, idleTimeoutMs);
  try {
    await streamEvents(session, handle, sessions, scope, cwd, hooks, async (state) => {
      await flush(state);
      return true;
    });
  } finally {
    if (handle.onUiSettled === session.armOrPauseIdle) handle.onUiSettled = undefined;
    clearTimeout(session.timer);
  }
  // If state already reached a terminal event (done/error/etc.) before the
  // watchdog or interrupt could land, don't clobber it — that real terminal
  // wins.
  const state = finalizeSessionState(session, handle, idleTimeoutMs);
  log.info('card', 'final', { terminal: state.terminal, interrupted: handle.interrupted });
  await flush(state);
  await reapRun(handle);
}

/** Outbound options shared by the card stream and fallback sends. */
type SendOpts = { replyTo?: string; replyInThread?: boolean };

/**
 * Card refresh interval while a run is live but its event stream is silent.
 * A single long tool call (a full `pnpm test`, a slow network fetch) emits no
 * events for minutes; without this the card's 「已用时长」 freezes and the run
 * looks hung. 5s is deliberately low-frequency: it is ~17x the 300ms patch
 * throttle, so it can never be the thing that trips Feishu's per-message
 * update rate limit (230020) during normal fast streaming.
 */
const CARD_HEARTBEAT_INTERVAL_MS = 5000;

/**
 * Byte ceiling for one text/markdown-mode message. Feishu caps a single
 * message's content at 30KB (same order as the card cap the paginator works
 * to); we split at 20KB to leave room for the post/JSON re-serialization the
 * wire format adds. Text mode has no card paginator behind it, so an oversized
 * answer would otherwise fail as one rejected message and the whole tail would
 * be lost.
 */
export const TEXT_MESSAGE_BUDGET = 20 * 1024;

/**
 * Send a text-mode reply, paginated: one oversized message is rejected by
 * Feishu and its tail never reaches the user. Splitting happens on line
 * boundaries (see `splitText`) and loses nothing.
 */
export async function sendTextPages(
  channel: LarkChannel,
  chatId: string,
  sendOpts: SendOpts,
  body: string,
): Promise<void> {
  for (const chunk of splitText(body, TEXT_MESSAGE_BUDGET)) {
    if (chunk.trim()) await channel.send(chatId, { markdown: chunk }, sendOpts);
  }
}

/**
 * Card reply mode pagination: drive the stream across multiple messages.
 * A single card can't hold an unbounded number of tool panels (Feishu
 * rejects cards over ~64KB, ErrCode 11310), so when a page's card JSON
 * approaches CARD_SIZE_BUDGET we finalize it with a "continues" note and
 * start the next page in a fresh message. Tables paginate the same way and
 * for the same error code — a card may hold at most five of them, however
 * small — except that the tables past the budget are *carried* to the next
 * page instead of being rendered on this one (see `splitByTableBudget`).
 * The event iterator, accumulated RunState, and idle watchdog all survive
 * across pages.
 */
export async function streamCardPages(
  channel: LarkChannel,
  chatId: string,
  sendOpts: SendOpts,
  handle: RunHandle,
  sessions: SessionStore,
  scope: string,
  cwd: string,
  idleTimeoutMs: number | undefined,
  hooks: AgentStreamHooks | undefined,
  filter: (state: RunState) => RunState,
): Promise<void> {
  const session = createStreamSession(handle, idleTimeoutMs);
  let pageIndex = 0;
  try {
    for (;;) {
      // Each page starts from a clean slate: text/tool blocks and reasoning
      // are reset so later pages render only NEW content — re-rendering the
      // accumulated state would immediately overflow again. Two exceptions
      // survive: tools still running (their tool_result can land on the next
      // page, and clearing them would drop the result — reduce can't find the
      // block by id) and content a table-budget cut pushed past this page.
      session.state = {
        ...session.state,
        // Thinking blocks rendered on previous pages are dropped with the
        // rest — only running tools and carried-over content survive.
        blocks: [...carryOverBlocks(session.state.blocks), ...session.carry],
      };
      session.carry = [];
      // The page's initial card is sent before any onState budget check
      // runs, so a carry past the byte budget would open the page with a
      // card Feishu rejects (>30KB cap). Trim this page's opening state to
      // fit; the trimmed remainder rides the next page via carry again.
      // 同一个 `pageNow` 贯穿这一页的「探测 + 初始卡」：两个渲染必须读同一段
      // 「用时」文本，否则跨秒边界会差 1 字节、分段结果不确定。
      const pageNow = Date.now();
      const initialSplit = splitByByteBudget(session.state, filter, pageNow);
      if (initialSplit.carry.length > 0) {
        session.state = initialSplit.page;
        session.carry = initialSplit.carry;
      }
      const overflow = await runCardPage(
        channel, chatId, sendOpts, session, handle, sessions, scope, cwd,
        idleTimeoutMs, hooks, filter, pageIndex, pageNow,
      );
      // Another page is needed while content is still owed to the user: either
      // the page cut at the table budget (carry) or the run is still streaming.
      // A terminal event that also overflowed means the content is complete;
      // opening another page would just emit an empty "continues" card.
      if (session.carry.length === 0 && (!overflow || session.done)) break;
      pageIndex += 1;
    }
  } catch (err) {
    // Card stream died mid-run (schema rejected, network, SDK limit…). Pages
    // already posted survive. Deliver the current page as a minimal card
    // first (near-impossible to reject); if even that fails, fall back to
    // plain text so the user's turn is never silently swallowed. Rethrow so
    // runAgentBatch still logs the failure. (The dead page's own card is
    // finalized in `runCardPage`'s catch — it knows that page's messageId.)
    const replyTo = sendOpts.replyTo;
    const sent = await sendManagedCard(channel, chatId, fallbackCard(session.state, filter), replyTo).catch(
      () => undefined,
    );
    if (sent) {
      // Nothing updates this card afterwards. Leaving it registered would
      // accumulate entries until the 200-card cap starts evicting live forms.
      forgetManagedCard(sent.messageId);
    } else {
      await channel.send(chatId, { markdown: fallbackContent(session.state, filter) }, sendOpts).catch(() =>
        log.fail('card', new Error('fallback send failed')),
      );
    }
    throw err;
  } finally {
    // Single reap point: normal end, interrupt, and mid-stream failure all
    // converge here — the OMP child must never outlive the run.
    await reapRun(handle);
    if (handle.onUiSettled === session.armOrPauseIdle) handle.onUiSettled = undefined;
    clearTimeout(session.timer);
  }
}


/**
 * 把一张停在运行态的卡片补成终态（尽力而为）。内容按表格与字节预算裁剪；补不上留记录。
 */
async function patchStrandedCard(
  channel: LarkChannel,
  messageId: string,
  session: StreamSession,
  handle: RunHandle,
  idleTimeoutMs: number | undefined,
  filter: (state: RunState) => RunState,
): Promise<boolean> {
  const final = finalizeSessionState(session, handle, idleTimeoutMs);
  // 一个 now 贯穿「字节探测 + 补卡渲染」：探测用 A 时刻、发送用 B 时刻会让
  // 「用时」字符串在秒边界处差 1 字节，切出来的卡可能刚好过线。
  if (!/^om_/.test(messageId)) {
    log.debug('card', 'stranded-skip-invalid-message', { messageId });
    return false;
  }
  const now = Date.now();
  const tableSplit = splitByTableBudget(final);
  const byteSource = tableSplit.carry.length > 0 ? { ...tableSplit.page, terminal: 'done' as const } : final;
  const split = splitByByteBudget(byteSource, filter, now);
  const card =
    split.carry.length > 0 || tableSplit.carry.length > 0
      ? renderCard(filter({ ...split.page, terminal: 'done' }), {
          now,
          bottomNote: '⚠️ 卡片更新失败，本条回复可能不完整',
        })
      : renderCard(filter(final), { now });
  try {
    if (await patchCardWithRetry(channel, messageId, card)) {
      forgetStreamingCard(messageId);
      log.info('card', 'stranded-finalized', { messageId, terminal: final.terminal });
      return true;
    }
  } catch (patchErr) {
    log.warn('card', 'stranded-finalize-failed', { messageId, err: String(patchErr) });
  }
  return false;
}
/** Run one card page; returns true if it overflowed (another page follows). */
async function runCardPage(
  channel: LarkChannel,
  chatId: string,
  sendOpts: SendOpts,
  session: StreamSession,
  handle: RunHandle,
  sessions: SessionStore,
  scope: string,
  cwd: string,
  idleTimeoutMs: number | undefined,
  hooks: AgentStreamHooks | undefined,
  filter: (state: RunState) => RunState,
  pageIndex: number,
  /** 这一页的开启时刻，与 streamCardPages 的字节探测共用同一值（见那里注释）。 */
  pageNow: number,
): Promise<boolean> {
  let overflow = false;
  // 这一页的「页面级」渲染选项：续页（pageIndex>0）顶部始终带「接上一条消息」。
  // 曾经只有初始卡与心跳带它，事件 patch 不带 —— 于是每来一个事件提示就消失、
  // 心跳又把它加回来，用户看到的就是「一会有一会没有」。
  const pageTop = pageIndex > 0 ? { topNote: '⬆️ 接上一条消息' } : {};
  // Whether any agent event was reduced into this page. A page that only
  // drains carry after the stream ended has already shown its content in
  // the initial card (rendered in terminal state) — a finalize push would
  // repeat that content verbatim on a second card.
  // Whether the card currently on screen already renders a terminal state. The
  // finalize push exists to add terminal marks (idle/interrupt/done) to a
  // still-running card; re-pushing an already-terminal card just duplicates the
  // user-visible content.
  //
  // 初始卡也算：它若是终态（排空页），这一页就没有补的必要；它若是运行态而整页
  // 一个事件都没来，**反而必须补** —— 否则那张卡永远停在运行态，用户会一直看着
  // 一个不消失的 ⏹ 终止按钮（旧代码要求 `sawEvent` 才补，这条静默路径就漏了）。
  let sawTerminalPush = filter(session.state).terminal !== 'running';
  const initialCard = renderCard(
    filter(session.state),
    { ...pageTop, now: pageNow },
  );
  // 这一页的飞书消息 id：producer 一开头就记下来（见下），收尾时用它决定
  // 「撤记录」还是「补终态」。**每一页各记各的** —— 从前它由外层的一个变量承接，
  // 多页时只记得最后一页，前面那张卡出问题就再也认不出来了。
  let pageMessageId: string | undefined;
  try {
    await channel.stream(
      chatId,
      {
        card: {
          initial: initialCard,
          producer: async (ctrl) => {
            // Crash recovery: streaming cards don't go through the managed-card
            // system, so persist their messageId + snapshot for the boot-time
            // finalizer (Feishu can't return card content afterwards).
            pageMessageId = ctrl.messageId;
            void rememberStreamingCard(ctrl.messageId, chatId, initialCard);
            let heartbeat: NodeJS.Timeout | undefined;
            try {
              const q = coalesceLatest((card: object) => {
                // Persist the snapshot BEFORE pushing: whatever reached Feishu is
                // what a crash-restart must replay.
                snapshotStreamingCard(ctrl.messageId, card);
                return ctrl.update(card);
              }, {
                minIntervalMs: CARD_UPDATE_MIN_INTERVAL_MS,
              });
              // 心跳：一次 `pnpm test` 之类的长工具调用期间，事件流可以几分钟没有
              // 任何一条事件 —— 没有 patch，卡片上的「已用时长」就冻住，用户看到的
              // 就是卡死。低频（5s）定时刷新让表继续走；它走同一个 q，因此仍然受
              // 300ms 节流保护，不会额外撞飞书的单消息更新限频。
              //
              // 存活期与这一页的 producer 等长：streamEvents 返回（终态 / 流结束 /
              // 溢出换页）后 interval 在 finally 里清掉；终态之后的兜底推送也不会
              // 再触发它（回调里再挡一次，防止在 finalize 的 await 窗口里插进来）。
              heartbeat = setInterval(() => {
                // 这一页已经在收尾（overflow）→ 不再推：SDK 的 patch 是异步的
                // 「最后写入者胜」，心跳若排在收尾卡之后，飞书上留下的就还是那个
                // 运行态画面（⏹ 挂着）—— 而登记会因为收尾成功被撤掉，卡就没人管了。
                if (overflow || session.state.terminal !== 'running') return;
                const heartbeatState = filter(session.state);
                const tableSplit = splitByTableBudget(heartbeatState);
                if (tableSplit.carry.length > 0) return;
                const heartbeatCard = renderCard(
                  heartbeatState,
                  { ...pageTop },
                );
                if (cardExceedsBudget(heartbeatCard, heartbeatState)) return;
                try {
                  q.push(heartbeatCard);
                } catch {
                  // 写失败会在 producer 的 await 路径上抛出并走正常收尾；定时器这条
                  // 独立调用栈上不能再抛（会成为 uncaughtException）。
                }
              }, CARD_HEARTBEAT_INTERVAL_MS);
              await streamEvents(session, handle, sessions, scope, cwd, hooks, async (state) => {
                // 同一个时刻既用于字节预算探测（renderCard + cardExceedsBudget），
                // 也用于随后推出去的那张卡：「用时」字符串在 60s 边界会变长，测量与
                // 发送若读不同时刻，探测就少算了一个字节。
                const now = Date.now();
                // Tables first: Feishu rejects a card past five table components
                // (ErrCode 11310 "card table number over limit") no matter how
                // small it is, so a page must be cut at the table budget rather
                // than rendered and bounced. The carry renders on the next page.
                const split = splitByTableBudget(state);
                if (split.carry.length > 0) {
                  overflow = true;
                  session.carry = split.carry;
                  q.push(
                    renderCard(filter({ ...split.page, terminal: 'done' }), {
                      ...pageTop,
                      now,
                      midPage: true,
                      bottomNote: '⬇️ 内容较长，已分页，下一条消息继续',
                    }),
                  );
                  await q.flush();
                  return false;
                }
                const filtered = filter(state);
                const card = renderCard(filtered, { ...pageTop, now });
                if (cardExceedsBudget(card, filtered)) {
                  // Close this page with only the content that FITS: the closing
                  // card used to carry the full overflowing state, so Feishu
                  // rejected it and the run died on the markdown fallback.
                  // Overflow blocks ride the next page via session.carry.
                  const byteSplit = splitByByteBudget(state, filter, now);
                  if (byteSplit.carry.length > 0) {
                    overflow = true;
                    session.carry = byteSplit.carry;
                    q.push(
                      renderCard(filter({ ...byteSplit.page, terminal: 'done' }), {
                        ...pageTop,
                        now,
                        midPage: true,
                        bottomNote: '⬇️ 内容较长，已分页，下一条消息继续',
                      }),
                    );
                    await q.flush();
                    return false;
                  }
                  // Un-splittable (carry empty): fall through and push the
                  // measured card — the stream may still survive if the closing
                  // render is leaner than the running one.
                }
                q.push(card);
                // A terminal event's own update already carries the final card
                // (done/error marks); the finalize push would repeat it.
                if (state.terminal !== 'running') sawTerminalPush = true;
                return true;
              });
              if (!overflow && !sawTerminalPush) {
                // Natural end of the whole stream: finalize + reap on this page.
                // The finalize push goes through the same byte split as a
                // mid-stream overflow — the drained carry can still be past the
                // 30KB Feishu cap, and an unchecked push here re-killed runs
                // that had paginated correctly all along.
                const final = finalizeSessionState(session, handle, idleTimeoutMs);
                log.info('card', 'final', {
                  terminal: final.terminal,
                  interrupted: handle.interrupted,
                });
                const now = Date.now();
                const byteSplit = splitByByteBudget(final, filter, now);
                if (byteSplit.carry.length > 0) {
                  session.carry = byteSplit.carry;
                  q.push(
                    renderCard(filter(byteSplit.page), {
                      ...pageTop,
                      now,
                      midPage: true,
                      bottomNote: '⬇️ 内容较长，已分页，下一条消息继续',
                    }),
                  );
                } else {
                  q.push(renderCard(filter(final), { ...pageTop, now }));
                }
                await q.flush();
                // (reap happens once in streamCardPages' finally, after all pages)
              }
            } finally {
              // 终态 / 换页 / 异常：三条路都必须停掉心跳，否则定时器会在卡片已经
              // 终结之后继续 patch（也会把测试进程吊住）。
              clearInterval(heartbeat);
            }
            // 登记**不在这里撤**：`ctrl.update()` 只是把卡片交给 SDK 的节流器，
            // 它立刻 resolve，真正的 im.message.patch 要等这一页的流收尾
            // （SDK 的 completeTerminal → throttle.flushNow）才落地 —— 失败也只
            // 在那一刻以 `channel.stream` 抛错的形式暴露。撤登记必须等那个确认
            // （见下面 stream 返回后的分支），否则「卡停在运行态 + 登记已删」这个
            // 最坏组合就会出现：既没人给它收尾，也没有记录让下次启动/巡检补卡。
          },
        },
      },
      sendOpts,
    );
  } catch (err) {
    // 这一页的流失败：SDK 收尾时把补卡队列排空并把失败抛了出来 —— 说明这张卡
    // **最后一次**更新没有落到飞书，它停在运行态（⏹ 挂着）。立刻把这张卡补成
    // 终态（按它自己的 messageId）；补不上就把登记留着，让启动兜底与周期巡检去收尾。
    const settled =
      pageMessageId !== undefined
        ? await patchStrandedCard(channel, pageMessageId, session, handle, idleTimeoutMs, filter)
        : false;
    // A card transport failure is a delivery downgrade, not an agent failure.
    // Stop this page and let the caller's normal reap path finish the run.
    session.done = true;
    log.warn('card', 'stream-degraded', {
      messageId: pageMessageId,
      settled,
      err: String(err),
    });
    // 降级链的最后一环：卡片这条路走不通（没拿到 messageId，或补卡也被拒）时，
    // **答案不能丢** —— 把已经产出的内容按纯文本分段投递（与文本模式同一套预算）。
    // 这里也不能把异常抛出去：交付降级不该把整轮 run 判死。
    if (!settled) {
      await sendTextPages(
        channel,
        chatId,
        sendOpts,
        renderText(filter(finalizeSessionState(session, handle, idleTimeoutMs))),
      )
        .then(() => log.info('card', 'stream-degraded-text', { messageId: pageMessageId }))
        .catch((sendErr) => {
          log.fail('card', sendErr, { step: 'stream-degraded-text', messageId: pageMessageId });
        });
    }
    return false;
  }
  // 流正常结束 = 这一页的最后一张画面确认落地，此刻才撤登记。
  if (pageMessageId !== undefined) forgetStreamingCard(pageMessageId);
  return overflow;
}

/**
 * How long to wait for OMP to close stdout after a terminal event before
 * forcing a SIGTERM. Empirically OMP's post-agent_end tail is well under a
 * second; 2s leaves headroom for slow flushes without making the user notice
 * a stall (the card has already rendered terminal state by this point).
 */
const POST_DONE_EXIT_GRACE_MS = 2000;

/**
 * Run a one-shot agent prompt for a scheduled task and stream the result to
 * a target chat (no triggering message — no replyTo, no quote fetching).
 * Reuses the same agent.run + processAgentStream machinery as a normal
 * batch, minus the media/quote/batch plumbing. Best-effort: failures are
 * logged and a short error notice is sent so the user knows the task ran
 * into trouble.
 */
export interface ScheduledRunDeps {
  channel: LarkChannel;
  agent: AgentAdapter;
  sessions: SessionStore;
  workspaces: WorkspaceStore;
  activeRuns: ActiveRuns;
  controls: Controls;
  pool: ProcessPool;
  chatId: string;
  prompt: string;
  /** Slot reserved by the scheduler handler before it fired this run. */
  claim: RunClaim;
}

export async function runScheduledPrompt(deps: ScheduledRunDeps): Promise<void> {
  const { channel, agent, sessions, workspaces, activeRuns, controls, pool, chatId, prompt, claim } = deps;
  const scope = chatId;
  const uiCards = new Map<string, UiCardEntry>();
  // Same across-the-bridge cap as an interactive run — a scheduled prompt must
  // not push the process count past maxConcurrentRuns. Acquired INSIDE the try
  // so a failure here still releases the caller's claim (a leaked claim leaves
  // the chat permanently busy).
  let release: (() => void) | undefined;
  try {
    release = await pool.acquire();
    const { cwd } = await resolveConversationCwd(workspaces, sessions, scope);
    const replyMode = getMessageReplyMode(controls.cfg);
    const runModel = getOmpModel(controls.cfg);
    if (runModel) await recordModelUse(runModel).catch(() => {});

    const feishuHost = createFeishuHostIntegration(channel, {
      scope,
      chatId,
      replyToMessageId: undefined,
      cwd,
      activeRuns,
      isChatAllowed: (target) => isChatAllowed(controls.cfg, target),
    });

    const run = agent.run({
      prompt,
      sessionId: sessions.sessionFor(scope)?.sessionId,
      cwd,
      model: runModel,
      thinking: getOmpThinking(controls.cfg),
      stopGraceMs: getAgentStopGraceMs(controls.cfg),
      hostTools: feishuHost.tools,
      hostUriSchemes: feishuHost.uriSchemes,
    });
    const handle = activeRuns.register(scope, run, claim);
    if (!handle) {
      log.warn('runs', 'register-failed', { scope, via: 'scheduler' });
      // 防御性：把 claim 还回去（这条路径不抛异常，调用方的 `.catch` 不会触发；
      // 与交互路径 finally 里的 releaseClaim 对称）。当前 register 在「claim 存活且
      // 无 handle」时必然成功，所以这条分支实际很难走到 —— 留着防止 contract 变化后泄漏。
      activeRuns.releaseClaim(claim);
      await run.stop().catch(() => {});
      return;
    }

    // UI 交互卡 hooks 建在 register 之后：倒计时要读 handle 的 pendingUiRequests
    // （见 createUiHooks 的 isPending），register 前还拿不到它。
    const uiHooks = createUiHooks({
      channel,
      chatId,
      scope,
      replyToMessageId: undefined,
      activeRuns,
      cards: uiCards,
      isPending: (requestId) => handle.pendingUiRequests.has(requestId),
    });

    try {
      if (replyMode === 'card') {
        await streamCardPages(
          channel,
          chatId,
          {},
          handle,
          sessions,
          scope,
          cwd,
          getRunIdleTimeoutMs(controls.cfg),
          uiHooks,
          (state) => filterToolBlocks(state, controls),
        );
      } else {
        let finalState: RunState = initialState;
        await processAgentStream(
          handle,
          sessions,
          scope,
          cwd,
          getRunIdleTimeoutMs(controls.cfg),
          async (state) => {
            finalState = state;
          },
          uiHooks,
        );
        const body = renderText(filterToolBlocks(finalState, controls));
        if (body.trim()) {
          await sendTextPages(channel, chatId, {}, body);
        }
      }
    } catch (err) {
      log.fail('scheduler', err, { chatId });
      // Same orphaned-run hazard as runAgentBatch's catch: detached OMP child
      // with an open stdin hangs forever if the stream dies mid-run.
      await run.stop().catch(() => {});
      try {
        await channel.send(chatId, { markdown: `⚠️ 定时任务执行失败：${err instanceof Error ? err.message : String(err)}` }, {});
      } catch {
        /* delivery failure is non-fatal */
      }
    } finally {
      activeRuns.unregister(scope, run);
    }
  } finally {
    for (const { messageId } of uiCards.values()) forgetManagedCard(messageId);
    uiCards.clear();
    release?.();
    activeRuns.releaseClaim(claim);
  }
}

function filterToolBlocks(state: RunState, controls: Controls): RunState {
  if (getShowToolCalls(controls.cfg)) return state;
  return { ...state, blocks: state.blocks.filter((b) => b.kind !== 'tool') };
}
