import { homedir } from 'node:os';
import { stat } from 'node:fs/promises';
import type { LarkChannel, NormalizedMessage } from '@larksuiteoapi/node-sdk';
import type { AgentAdapter, AgentEvent, AgentUiRequest } from '../agent/types';
import type { ActiveRuns, RunClaim, RunHandle } from './active-runs';
import { createFeishuHostIntegration } from './feishu-host';
import { forgetManagedCard, sendManagedCard, updateManagedCard } from '../card/managed';
import { renderOmpUiRequestCard, renderOmpUiResultCard } from '../card/omp-ui';
import { renderCard, type RunCard } from '../card/run-renderer';
import { createTableBudget, splitByTableBudget } from '../card/tables';
import {
  finalizeIfRunning,
  initialState,
  markIdleTimeout,
  markInterrupted,
  reduce,
  type Block,
  type RunState,
} from '../card/run-state';
import { renderText } from '../card/text-renderer';
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
import { log } from '../core/logger';
import { attachTextExtracts, type MediaCache } from '../media/cache';
import { attachTranscripts } from '../media/transcribe';
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
}

/**
 * Bridge OMP's extension UI requests to interactive Feishu cards. Shared by
 * the interactive batch and the scheduled-prompt path, so a scheduled run's
 * confirm/select is answerable instead of stalling the run forever.
 *
 * `replyToMessageId` threads the card under the user's message; a scheduled
 * run has none and posts at chat level.
 */
function createUiHooks(opts: {
  channel: LarkChannel;
  chatId: string;
  scope: string;
  replyToMessageId: string | undefined;
  activeRuns: ActiveRuns;
  cards: Map<string, UiCardEntry>;
}): AgentStreamHooks {
  const { channel, chatId, scope, replyToMessageId, activeRuns, cards } = opts;
  return {
    async onUiRequest(request) {
      try {
        const existing = cards.get(request.id);
        if (existing) {
          await updateManagedCard(channel, existing.messageId, renderOmpUiRequestCard(request, scope));
          existing.title = request.title;
          return;
        }
        const sent = await sendManagedCard(
          channel,
          chatId,
          renderOmpUiRequestCard(request, scope),
          replyToMessageId,
        );
        cards.set(request.id, { messageId: sent.messageId, title: request.title });
        // Auto-cancel on timeout: while OMP waits for UI input the idle
        // watchdog is paused, so an unanswered prompt would hang the run
        // forever. The timer is cancelled in ActiveRuns.respondToUi when the
        // user answers first.
        if ('timeout' in request && request.timeout !== undefined && request.timeout > 0) {
          activeRuns.armUiTimeout(scope, request.id, request.timeout, () => {
            activeRuns.respondToUi(scope, request.id, { cancelled: true, timedOut: true });
            updateManagedCard(channel, sent.messageId, renderOmpUiResultCard(request.title, 'timed_out'))
              .catch(() => {
                /* card update is best-effort */
              })
              .finally(() => forgetManagedCard(sent.messageId));
            cards.delete(request.id);
          });
        }
      } catch (err) {
        // The request is already registered as outstanding, and an outstanding
        // request pauses the idle watchdog. With no card on screen and no timer
        // armed, the run (and its OMP child) would wait for an answer that can
        // never arrive — answer it as cancelled so the agent moves on.
        log.fail('omp-ui', err, { scope, requestId: request.id, method: request.method });
        activeRuns.respondToUi(scope, request.id, { cancelled: true });
        activeRuns.dropUiRequest(scope, request.id);
      }
    },
    async onUiCancel(targetId) {
      const entry = cards.get(targetId);
      if (!entry) return;
      cards.delete(targetId);
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
  await attachTranscripts(channel, attachments);
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

  const cwd = await resolveRunCwd(workspaces, scope);
  const resumeFrom = sessions.resumeFor(scope, cwd);
  if (resumeFrom) {
    log.info('session', 'resume', { sessionId: resumeFrom, cwd });
  } else {
    const stale = sessions.getRaw(scope);
    // Only a real session can be stale. An entry with no cwd (created by
    // /timeout or /rename before the first run) must survive: `undefined !== cwd`
    // used to match here and wipe the user's override/title on the next message.
    if (stale?.sessionId !== undefined && stale.cwd !== cwd) {
      log.info('session', 'stale-cleared', { staleCwd: stale.cwd, newCwd: cwd });
      sessions.clearSessionId(scope);
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

  const uiCards = new Map<string, UiCardEntry>();
  const uiHooks = createUiHooks({
    channel,
    chatId,
    scope,
    replyToMessageId: lastMsg.messageId,
    activeRuns,
    cards: uiCards,
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
        await channel.send(chatId, { markdown: body }, sendOpts);
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
  // rejects. Without this, that chat is bricked: every later message dies on
  // the same lookup error. Drop the dead id and replay the batch once.
  if (resumeFrom && !retriedStaleSession && run.staleSession) {
    log.warn('session', 'stale-cleared', { sessionId: resumeFrom, cwd });
    // Drop only the dead id: title and idle-timeout override are user
    // preferences that survive a session rollover (see SessionStore.set).
    sessions.clearSessionId(scope);
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
    state: initialState,
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
        sessions.set(scope, evt.sessionId, effectiveCwd);
        log.info('session', 'set', { sessionId: evt.sessionId });
      }
      continue;
    }
    if (evt.type === 'usage') {
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
async function resolveRunCwd(workspaces: WorkspaceStore, scope: string): Promise<string> {
  let cwd = workspaces.cwdFor(scope) ?? homedir();
  try {
    const st = await stat(cwd);
    if (!st.isDirectory()) throw new Error('not a directory');
  } catch {
    log.warn('session', 'cwd-missing', { staleCwd: cwd });
    cwd = homedir();
    workspaces.setCwd(scope, cwd);
  }
  return cwd;
}

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
        blocks: [...carryOverBlocks(session.state.blocks), ...session.carry],
        reasoning: { content: '', active: false },
      };
      session.carry = [];
      const overflow = await runCardPage(
        channel, chatId, sendOpts, session, handle, sessions, scope, cwd,
        idleTimeoutMs, hooks, filter, pageIndex,
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
    // runAgentBatch still logs the failure.
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
 * Markdown text for the card-stream fallback. When card rendering dies
 * mid-run we deliver whatever the current page holds instead of stranding
 * the user on a forever-running card.
 */
export function fallbackContent(state: RunState, filter: (s: RunState) => RunState): string {
  const text = renderText(filter(state)).trim();
  return text
    ? `⚠️ 卡片渲染中断，剩余内容如下：\n\n${text}`
    : '⚠️ 回复渲染失败。可 /doctor 查看日志。';
}

/**
 * Minimal schema-2.0 card for the fallback: a single markdown element, no
 * panels/buttons/notes — the smallest surface Feishu can reject. It is also
 * table-capped: the content that killed the run is often table-heavy, and a
 * fallback rejected by the same ErrCode 11310 would strand the user on the
 * plain-text path.
 */
export function fallbackCard(state: RunState, filter: (s: RunState) => RunState): object {
  return {
    schema: '2.0',
    config: { summary: { content: '回复（降级）' } },
    body: {
      elements: [{ tag: 'markdown', content: createTableBudget()(fallbackContent(state, filter)) }],
    },
  };
}

/**
 * Blocks carried into the next page. Only running tools survive: their
 * `tool_result` may arrive after the page boundary, and clearing them would
 * make `reduce` fail to find the block by id, silently dropping the result.
 * Done tools and text blocks are already rendered on the page being closed.
 */
export function carryOverBlocks(blocks: Block[]): Block[] {
  return blocks.filter((b) => b.kind === 'tool' && b.tool.status === 'running');
}


/**
 * Latest-wins write coalescer. At most one write in flight; newer values
 * overwrite the pending slot. `flush()` waits for in-flight + pending so
 * the last value always lands. Errors surface on the next `push`/`flush`.
 */
/**
 * Card JSON size budget per page. Feishu rejects cards over ~64KB (ErrCode
 * 11310 "element exceeds the limit"); we paginate at 48KB to leave headroom
 * for text/button/footer and JSON key overhead that a simple
 * JSON.stringify-length check undercounts.
 */
const CARD_SIZE_BUDGET = 48 * 1024;
/**
 * Element-count budget per page. Feishu also rejects a streaming card whose
 * body grows past ~50 elements — same ErrCode 11310, observed in production
 * at 55 elements / 44KB (well under the byte budget). Runs with many small
 * tool calls hit this first, so paginate on count too.
 */
const CARD_ELEMENT_BUDGET = 40;

export function coalesceLatest<T>(write: (value: T) => Promise<void>): {
  push(value: T): void;
  flush(): Promise<void>;
} {
  let pending: T | undefined;
  let inFlight: Promise<void> | undefined;
  let failed: unknown;
  const pump = async (): Promise<void> => {
    try {
      while (pending !== undefined) {
        const value = pending;
        pending = undefined;
        await write(value);
      }
    } catch (err) {
      failed = err;
    } finally {
      inFlight = undefined;
      if (pending !== undefined && !failed) inFlight = pump();
    }
  };
  return {
    push(value) {
      if (failed) throw failed;
      pending = value;
      inFlight ??= pump();
    },
    async flush() {
      while (inFlight) await inFlight;
      if (failed) throw failed;
      if (pending !== undefined) {
        const value = pending;
        pending = undefined;
        await write(value);
      }
    },
  };
}

/** Rough serialized size (UTF-8 bytes) of the content a card will carry. */
function runContentBytes(state: RunState): number {
  let n = 0;
  const add = (s: string): void => {
    n += Buffer.byteLength(s, 'utf8');
  };
  for (const b of state.blocks) {
    if (b.kind === 'text') {
      add(b.content);
    } else {
      add(b.tool.output ?? '');
      n += 400; // per-tool collapsible_panel chrome (header/icon/border JSON)
      const input = b.tool.input;
      if (typeof input === 'string') add(input);
      else if (input && typeof input === 'object') {
        for (const v of Object.values(input as Record<string, unknown>)) {
          if (typeof v === 'string') add(v);
        }
      }
    }
  }
  add(state.reasoning.content.slice(0, 1500));
  if (state.ui.editorText) add(state.ui.editorText.slice(0, 1200));
  for (const w of Object.values(state.ui.widgets)) {
    for (const line of w.lines ?? []) add(line);
  }
  return n;
}

export function cardExceedsBudget(card: RunCard, state: RunState): boolean {
  if (card.body.elements.length > CARD_ELEMENT_BUDGET) return true;
  // Feishu caps the serialized card in BYTES, not JS string length. CJK is
  // ~3 bytes per char, so a char-based budget undercounted a Chinese answer by
  // 3x — 20k chars is already ~59KB of JSON, at the cap, yet passed as "fine".
  // Skip the stringify until content is actually near the cap.
  if (runContentBytes(state) + 8 * 1024 < CARD_SIZE_BUDGET) return false;
  return Buffer.byteLength(JSON.stringify(card), 'utf8') > CARD_SIZE_BUDGET;
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
): Promise<boolean> {
  let overflow = false;
  await channel.stream(
    chatId,
    {
      card: {
        initial: renderCard(
          filter(session.state),
          pageIndex > 0 ? { topNote: '⬆️ 接上一条消息' } : undefined,
        ),
        producer: async (ctrl) => {
          const q = coalesceLatest((card: object) => ctrl.update(card));
          await streamEvents(session, handle, sessions, scope, cwd, hooks, async (state) => {
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
                  bottomNote: '⬇️ 内容较长，已分页，下一条消息继续',
                }),
              );
              await q.flush();
              return false;
            }
            const filtered = filter(state);
            const card = renderCard(filtered);
            if (cardExceedsBudget(card, filtered)) {
              overflow = true;
              // Finalize this page as a terminal card with a "continues"
              // note; the run itself is still going (next page picks it up).
              q.push(
                renderCard(filter({ ...state, terminal: 'done' }), {
                  bottomNote: '⬇️ 内容较长，已分页，下一条消息继续',
                }),
              );
              await q.flush();
              return false;
            }
            q.push(card);
            return true;
          });
          if (!overflow) {
            // Natural end of the whole stream: finalize + reap on this page.
            const final = finalizeSessionState(session, handle, idleTimeoutMs);
            log.info('card', 'final', {
              terminal: final.terminal,
              interrupted: handle.interrupted,
            });
            q.push(renderCard(filter(final)));
            await q.flush();
            // (reap happens once in streamCardPages' finally, after all pages)
          }
        },
      },
    },
    sendOpts,
  );
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
  const uiHooks = createUiHooks({
    channel,
    chatId,
    scope,
    replyToMessageId: undefined,
    activeRuns,
    cards: uiCards,
  });
  // Same across-the-bridge cap as an interactive run — a scheduled prompt must
  // not push the process count past maxConcurrentRuns. Acquired INSIDE the try
  // so a failure here still releases the caller's claim (a leaked claim leaves
  // the chat permanently busy).
  let release: (() => void) | undefined;
  try {
    release = await pool.acquire();
    const cwd = await resolveRunCwd(workspaces, scope);
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
      sessionId: sessions.resumeFor(scope, cwd),
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
      await run.stop().catch(() => {});
      return;
    }

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
          await channel.send(chatId, { markdown: body }, {});
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
