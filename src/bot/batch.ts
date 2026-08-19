import { homedir } from 'node:os';
import { stat } from 'node:fs/promises';
import type { LarkChannel, NormalizedMessage } from '@larksuiteoapi/node-sdk';
import type { AgentAdapter, AgentEvent, AgentUiRequest } from '../agent/types';
import type { ActiveRuns, RunHandle } from './active-runs';
import { createFeishuHostIntegration } from './feishu-host';
import { sendManagedCard, updateManagedCard } from '../card/managed';
import { renderOmpUiRequestCard, renderOmpUiResultCard } from '../card/omp-ui';
import { renderCard } from '../card/run-renderer';
import {
  finalizeIfRunning,
  initialState,
  markIdleTimeout,
  markInterrupted,
  reduce,
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
} from '../config/schema';
import { log } from '../core/logger';
import type { MediaCache } from '../media/cache';
import { attachTranscripts } from '../media/transcribe';
import type { SessionStore } from '../session/store';
import type { WorkspaceStore } from '../workspace/store';
import { recordModelUse } from '../session/model-history';
import type { ChatMode } from './chat-mode-cache';
import { buildPrompt } from './prompt';
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
}

export interface AgentStreamHooks {
  onUiRequest(request: AgentUiRequest): Promise<void>;
  onUiCancel(targetId: string): Promise<void>;
}

export async function runAgentBatch(deps: RunBatchDeps): Promise<void> {
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
  // Voice messages: transcribe to text so the agent can read the content.
  await attachTranscripts(channel, attachments);
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
  const quotes: QuotedContext[] = [];
  for (const targetId of quoteTargets) {
    const q = await fetchQuotedContext(channel, targetId);
    if (q) {
      quotes.push(q);
      log.info('quote', 'fetched', {
        messageId: targetId,
        type: q.rawContentType,
        contentChars: q.content.length,
      });
    }
  }

  const prompt = buildPrompt(batch, attachments, quotes);
  log.info('prompt', 'built', { promptChars: prompt.length, quotes: quotes.length });

  const cwd = await resolveRunCwd(workspaces, scope);
  const resumeFrom = sessions.resumeFor(scope, cwd);
  if (resumeFrom) {
    log.info('session', 'resume', { sessionId: resumeFrom, cwd });
  } else {
    const stale = sessions.getRaw(scope);
    if (stale && stale.cwd !== cwd) {
      log.info('session', 'stale-cleared', { staleCwd: stale.cwd, newCwd: cwd });
      sessions.clear(scope);
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
  const handle = activeRuns.register(scope, run);

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
  const filterForPrefs = (state: RunState): RunState => {
    if (getShowToolCalls(controls.cfg)) return state;
    return { ...state, blocks: state.blocks.filter((b) => b.kind !== 'tool') };
  };

  // For topic groups: thread the reply so it lands in the same topic as the
  // user's message. Otherwise the SDK posts at top level and the user's
  // topic discussion breaks visually.
  const sendOpts = {
    replyTo: lastMsg.messageId,
    ...(mode === 'topic' && threadId ? { replyInThread: true } : {}),
  };

  const uiCards = new Map<string, { messageId: string; title: string }>();
  const uiHooks: AgentStreamHooks = {
    async onUiRequest(request) {
      try {
        const existing = uiCards.get(request.id);
        if (existing) {
          await updateManagedCard(channel, existing.messageId, renderOmpUiRequestCard(request, scope));
          existing.title = request.title;
          return;
        }
        const sent = await sendManagedCard(channel, chatId, renderOmpUiRequestCard(request, scope), lastMsg.messageId);
        uiCards.set(request.id, { messageId: sent.messageId, title: request.title });
      } catch (err) {
        log.fail('omp-ui', err, { scope, requestId: request.id, method: request.method });
      }
    },
    async onUiCancel(targetId) {
      const entry = uiCards.get(targetId);
      if (!entry) return;
      try {
        await updateManagedCard(channel, entry.messageId, renderOmpUiResultCard(entry.title, 'cancelled'));
      } catch (err) {
        log.fail('omp-ui', err, { scope, requestId: targetId, step: 'cancel-update' });
      }
    },
  };

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
        filterForPrefs,
      );
    } else if (replyMode === 'markdown') {
      await channel.stream(
        chatId,
        {
          markdown: async (ctrl) => {
            await processAgentStream(handle, sessions, scope, cwd, idleTimeoutMs, async (state) => {
              await ctrl.setContent(renderText(filterForPrefs(state)));
            }, uiHooks);
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
      const body = renderText(filterForPrefs(finalState));
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
    activeRuns.unregister(scope, run);
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
      log.info('agent', 'tool-in-flight', {
        tool: evt.name,
        inFlight: session.inFlightTools.size,
      });
    } else if (evt.type === 'tool_result') {
      session.inFlightTools.delete(evt.id);
      log.info('agent', 'tool-done', { inFlight: session.inFlightTools.size });
    } else if (evt.type === 'ui_request') {
      handle.pendingUiRequests.add(evt.request.id);
      log.info('agent', 'ui-in-flight', {
        method: evt.request.method,
        inFlight: handle.pendingUiRequests.size,
      });
    } else if (evt.type === 'ui_cancel') {
      handle.pendingUiRequests.delete(evt.targetId);
      log.info('agent', 'ui-cancelled', { inFlight: handle.pendingUiRequests.size });
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

/**
 * Card reply mode pagination: drive the stream across multiple messages.
 * A single card can't hold an unbounded number of tool panels (Feishu
 * rejects cards over ~64KB, ErrCode 11310), so when a page's card JSON
 * approaches CARD_SIZE_BUDGET we finalize it with a "continues" note and
 * start the next page in a fresh message. The event iterator, accumulated
 * RunState, and idle watchdog all survive across pages.
 */
async function streamCardPages(
  channel: LarkChannel,
  chatId: string,
  sendOpts: object,
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
    while (!session.done) {
      // Each page starts from a clean slate: text/tool blocks and reasoning
      // are reset so later pages render only NEW content — re-rendering the
      // accumulated state would immediately overflow again.
      session.state = { ...session.state, blocks: [], reasoning: { content: '', active: false } };
      const overflow = await runCardPage(
        channel, chatId, sendOpts, session, handle, sessions, scope, cwd,
        idleTimeoutMs, hooks, filter, pageIndex,
      );
      if (!overflow) break;
      // A terminal event that ALSO overflowed means the content is complete;
      // opening another page would just emit an empty "continues" card.
      if (session.state.terminal !== 'running') break;
      pageIndex += 1;
    }
  } finally {
    // Single reap point: normal end, interrupt, and mid-stream failure all
    // converge here — the OMP child must never outlive the run.
    await reapRun(handle);
    if (handle.onUiSettled === session.armOrPauseIdle) handle.onUiSettled = undefined;
    clearTimeout(session.timer);
  }
}

/** Run one card page; returns true if it overflowed (another page follows). */
async function runCardPage(
  channel: LarkChannel,
  chatId: string,
  sendOpts: object,
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
          await streamEvents(session, handle, sessions, scope, cwd, hooks, async (state) => {
            const card = renderCard(filter(state));
            if (JSON.stringify(card).length > CARD_SIZE_BUDGET) {
              overflow = true;
              // Finalize this page as a terminal card with a "continues"
              // note; the run itself is still going (next page picks it up).
              await ctrl.update(
                renderCard(filter({ ...state, terminal: 'done' }), {
                  bottomNote: '⬇️ 内容较长，已分页，下一条消息继续',
                }),
              );
              return false;
            }
            await ctrl.update(card);
            return true;
          });
          if (!overflow) {
            // Natural end of the whole stream: finalize + reap on this page.
            const final = finalizeSessionState(session, handle, idleTimeoutMs);
            log.info('card', 'final', {
              terminal: final.terminal,
              interrupted: handle.interrupted,
            });
            await ctrl.update(renderCard(filter(final)));
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
 * Card JSON size budget per page. Feishu rejects cards over ~64KB (ErrCode
 * 11310 "element exceeds the limit"); we paginate at 48KB to leave headroom
 * for text/button/footer and JSON key overhead that a simple
 * JSON.stringify-length check undercounts.
 */
const CARD_SIZE_BUDGET = 48 * 1024;

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
  chatId: string;
  prompt: string;

}

export async function runScheduledPrompt(deps: ScheduledRunDeps): Promise<void> {
  const { channel, agent, sessions, workspaces, activeRuns, controls, chatId, prompt } = deps;
  const scope = chatId;
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
  const handle = activeRuns.register(scope, run);

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
        undefined,
        (state) => filterToolBlocks(state, controls),
      );
    } else {
      let finalState: RunState = initialState;
      await processAgentStream(handle, sessions, scope, cwd, getRunIdleTimeoutMs(controls.cfg), async (state) => {
        finalState = state;
      });
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
}

function filterToolBlocks(state: RunState, controls: Controls): RunState {
  if (getShowToolCalls(controls.cfg)) return state;
  return { ...state, blocks: state.blocks.filter((b) => b.kind !== 'tool') };
}
