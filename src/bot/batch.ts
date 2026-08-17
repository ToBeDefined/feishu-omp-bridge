import { homedir } from 'node:os';
import { stat } from 'node:fs/promises';
import type { LarkChannel, NormalizedMessage } from '@larksuiteoapi/node-sdk';
import type { AgentAdapter, AgentUiRequest } from '../agent/types';
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

  let cwd = workspaces.cwdFor(scope) ?? homedir();
  // The chat's recorded cwd may point at a deleted/renamed directory;
  // spawning omp there fails with ENOENT. Verify it exists, falling back to
  // $HOME and repairing the stored workspace so the next run doesn't trip
  // the same way.
  try {
    const st = await stat(cwd);
    if (!st.isDirectory()) throw new Error('not a directory');
  } catch {
    log.warn('session', 'cwd-missing', { staleCwd: cwd });
    cwd = homedir();
    workspaces.setCwd(scope, cwd);
  }
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
      await channel.stream(
        chatId,
        {
          card: {
            initial: renderCard(initialState),
            producer: async (ctrl) => {
              await processAgentStream(handle, sessions, scope, cwd, idleTimeoutMs, async (state) => {
                await ctrl.update(renderCard(filterForPrefs(state)));
              }, uiHooks);
            },
          },
        },
        sendOpts,
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
  } finally {
    activeRuns.unregister(scope, run);
  }
}

/**
 * Drive the agent's event stream into a stateful RunState, calling `flush`
 * on every state transition. Used by both card and markdown reply modes —
 * the only difference between the two is what `flush` does with the state.
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
  let state: RunState = initialState;

  // Idle watchdog: OMP going silent for `idleTimeoutMs` is treated as
  // "presumed hung", we stop() and surface a timeout marker on the card.
  //
  // BUT — OMP can legitimately be silent for a long time when it's
  // waiting on a long-running tool call (e.g. `lark-cli` printing an
  // OAuth URL and blocking until the user clicks authorize) or on an OMP
  // native UI prompt that the user must answer from a Feishu card.
  // Pause the watchdog while either a tool or UI request is in flight.
  //
  // The watchdog re-arms when:
  //  - a tool_result drains the in-flight set to zero, OR
  //  - any non-tool event arrives while the set is empty.
  let idleFired = false;
  let timer: NodeJS.Timeout | undefined;
  const inFlightTools = new Set<string>();
  const armOrPauseIdle = (): void => {
    if (!idleTimeoutMs) return;
    if (timer) clearTimeout(timer);
    timer = undefined;
    if (inFlightTools.size > 0 || handle.pendingUiRequests.size > 0) return;
    timer = setTimeout(() => {
      idleFired = true;
      handle.interrupted = true;
      log.warn('agent', 'idle-timeout', { scope, idleTimeoutMs });
      void handle.run.stop().catch(() => {
        /* stop errors are non-fatal */
      });
    }, idleTimeoutMs);
  };
  handle.onUiSettled = armOrPauseIdle;
  armOrPauseIdle();

  try {
    for await (const evt of handle.run.events) {
      if (handle.interrupted) break;

      // Track tool/UI flight before re-arming the idle timer so the arm step
      // sees the correct set size. tool_use/ui_request open a window;
      // tool_result/ui response/cancel closes it.
      if (evt.type === 'tool_use') {
        inFlightTools.add(evt.id);
        log.info('agent', 'tool-in-flight', {
          tool: evt.name,
          inFlight: inFlightTools.size,
        });
      } else if (evt.type === 'tool_result') {
        inFlightTools.delete(evt.id);
        log.info('agent', 'tool-done', { inFlight: inFlightTools.size });
      } else if (evt.type === 'ui_request') {
        handle.pendingUiRequests.add(evt.request.id);
        log.info('agent', 'ui-in-flight', { method: evt.request.method, inFlight: handle.pendingUiRequests.size });
      } else if (evt.type === 'ui_cancel') {
        handle.pendingUiRequests.delete(evt.targetId);
        log.info('agent', 'ui-cancelled', { inFlight: handle.pendingUiRequests.size });
      }
      armOrPauseIdle();

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

      const prevTerminal = state.terminal;
      const prevFooter = state.footer;
      state = reduce(state, evt);
      if (state.footer !== prevFooter || state.terminal !== prevTerminal) {
        log.info('card', 'transition', { footer: state.footer, terminal: state.terminal });
      }
      await flush(state);
      // Stop iterating as soon as we have a terminal state. Some OMP
      // RPC runs may leave stdout open briefly after agent_end, which
      // would leave the for-await waiting forever otherwise.
      if (state.terminal !== 'running') break;
    }
  } finally {
    if (handle.onUiSettled === armOrPauseIdle) handle.onUiSettled = undefined;
    if (timer) clearTimeout(timer);
  }

  // If state already reached a terminal event (done/error/etc.) before the
  // watchdog or interrupt could land, don't clobber it — that real terminal
  // wins. This avoids "OMP finished but flush was slow → timer fired
  // mid-flush → user sees 'idle_timeout' on a successful run".
  if (state.terminal === 'running') {
    if (idleFired) {
      state = markIdleTimeout(state, Math.round(idleTimeoutMs! / 60_000));
    } else if (handle.interrupted) {
      state = markInterrupted(state);
    } else {
      state = finalizeIfRunning(state);
    }
  }
  log.info('card', 'final', { terminal: state.terminal, interrupted: handle.interrupted });
  await flush(state);
  // Reap the subprocess. Two regimes:
  //  - Interrupted (user /stop, idle watchdog, disconnect): stop() was already
  //    fire-and-forgotten by whoever set handle.interrupted; this awaits it.
  //  - Natural done: agent_end can arrive before OMP has fully closed stdout.
  //    Wait it out so the run exits with
  //    code 0; only SIGTERM as a hung-process safety net.
  if (handle.interrupted) {
    await handle.run.stop();
  } else {
    const exited = await handle.run.waitForExit(POST_DONE_EXIT_GRACE_MS);
    if (!exited) {
      log.warn('agent', 'post-done-timeout', { graceMs: POST_DONE_EXIT_GRACE_MS });
      await handle.run.stop();
    }
  }
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
  chatId: string;
  prompt: string;
  senderId: string;
}

export async function runScheduledPrompt(deps: ScheduledRunDeps): Promise<void> {
  const { channel, agent, sessions, workspaces, activeRuns, controls, chatId, prompt, senderId } = deps;
  const scope = chatId;
  const cwd = workspaces.cwdFor(scope) ?? homedir();
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
    stopGraceMs: getAgentStopGraceMs(controls.cfg),
    hostTools: feishuHost.tools,
    hostUriSchemes: feishuHost.uriSchemes,
  });
  const handle = activeRuns.register(scope, run);

  try {
    if (replyMode === 'card') {
      await channel.stream(
        chatId,
        {
          card: {
            initial: renderCard(initialState),
            producer: async (ctrl) => {
              await processAgentStream(handle, sessions, scope, cwd, getRunIdleTimeoutMs(controls.cfg), async (state) => {
                await ctrl.update(renderCard(filterToolBlocks(state, controls)));
              });
            },
          },
        },
        {},
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
