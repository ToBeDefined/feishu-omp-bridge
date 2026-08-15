import type { LarkChannel, NormalizedMessage } from '@larksuiteoapi/node-sdk';
import type { AgentAdapter } from '../agent/types';
import { tryHandleCommand, type Controls } from '../commands';
import {
  getRequireMentionInGroup,
  isChatAllowed,
  isUserAllowed,
} from '../config/schema';
import { log } from '../core/logger';
import type { MediaCache } from '../media/cache';
import type { SessionStore } from '../session/store';
import type { WorkspaceStore } from '../workspace/store';
import type { ActiveRuns } from './active-runs';
import type { ChatModeCache } from './chat-mode-cache';
import type { PendingQueue } from './pending-queue';
import { buildPrompt } from './prompt';
import { fetchQuotedContext, type QuotedContext } from './quote';
import { addReaction } from './reaction';

const DEBOUNCE_MS = 600;

export interface IntakeDeps {
  channel: LarkChannel;
  agent: AgentAdapter;
  sessions: SessionStore;
  workspaces: WorkspaceStore;
  activeRuns: ActiveRuns;
  media: MediaCache;
  pending: PendingQueue;
  msg: NormalizedMessage;
  controls: Controls;
  chatModeCache: ChatModeCache;
}

export async function intakeMessage(deps: IntakeDeps): Promise<void> {
  const {
    channel,
    agent,
    sessions,
    workspaces,
    activeRuns,
    media,
    pending,
    msg,
    controls,
    chatModeCache,
  } = deps;
  const preview = msg.content.length > 80 ? `${msg.content.slice(0, 80)}…` : msg.content;
  // Resolve scope (and underlying chat mode) once at intake — every
  // downstream consumer keys off these.
  const chatMode = await chatModeCache.resolve(channel, msg.chatId);
  const scope = chatMode === 'topic' && msg.threadId
    ? `${msg.chatId}:${msg.threadId}`
    : msg.chatId;
  log.info('intake', 'enter', {
    scope,
    chatType: msg.chatType,
    chatMode,
    sender: msg.senderId,
    preview,
    resources: msg.resources.length,
  });

  // Access control. Silent drop — replying would reveal the bot to
  // unauthorized users and let them spam the chat with denial messages.
  // Operator-defined lists; both empty = allow all (back-compat).
  if (!isUserAllowed(controls.cfg, msg.senderId)) {
    log.info('intake', 'skip-not-allowed-user', {
      scope,
      sender: msg.senderId.slice(-6),
    });
    return;
  }
  // `allowedChats` is intentionally a group-only gate. p2p chat_ids are
  // generated per-user-pair and can't be hijacked by an unauthorized
  // sender, so the user allowlist above is already authoritative for DMs.
  // Restricting p2p by chat_id would also create a chicken-and-egg lockout
  // hazard (the operator must know the chat_id before they ever DM the bot).
  if (msg.chatType !== 'p2p' && !isChatAllowed(controls.cfg, msg.chatId)) {
    log.info('intake', 'skip-not-allowed-chat', {
      scope,
      chatId: msg.chatId.slice(-6),
    });
    return;
  }

  // Group-mention policy. p2p is always unrestricted; in groups (regular and
  // topic) we drop messages that don't @bot when the user has opted into the
  // quiet-by-default behavior. Slash commands are NOT exempt — the user
  // chose strict mode so the group stays uniformly quiet unless mentioned.
  // @全员 is already filtered by SDK (`respondToMentionAll: false`), so any
  // event reaching here is either targeted or undirected chatter.
  if (
    msg.chatType !== 'p2p' &&
    getRequireMentionInGroup(controls.cfg) &&
    !msg.mentionedBot
  ) {
    log.info('intake', 'skip-no-mention', { scope, chatType: msg.chatType });
    return;
  }

  // Instant "got it" ack: add a Typing reaction the moment a message
  // passes access control, so the user knows it was received — for plain
  // messages (while we debounce / wait for a run slot), slash commands
  // (before the reply card lands), and mid-run follow-ups alike. Left in
  // place permanently as a receipt.
  await addReaction(channel, msg.messageId);

  const handled = await tryHandleCommand({
    channel,
    msg,
    scope,
    chatMode,
    sessions,
    workspaces,
    agent,
    activeRuns,
    controls,
  });
  if (handled) {
    const dropped = pending.cancel(scope);
    log.info('intake', 'command', { scope, droppedPending: dropped.length });
    return;
  }

  if (await submitToActiveRun({ channel, activeRuns, media, msg, scope })) {
    log.info('intake', 'submitted-active-run', { scope });
    return;
  }

  const size = pending.push(scope, msg);
  log.info('intake', 'queued', { scope, queueSize: size, debounceMs: DEBOUNCE_MS });
}

export async function submitToActiveRun(deps: {
  channel: LarkChannel;
  activeRuns: ActiveRuns;
  media: MediaCache;
  msg: NormalizedMessage;
  scope: string;
}): Promise<boolean> {
  const { channel, activeRuns, media, msg, scope } = deps;
  if (!activeRuns.has(scope)) return false;
  const resources = msg.resources.map((resource) => ({ messageId: msg.messageId, resource }));
  const attachments = await media.resolve(msg.chatId, resources);
  const imagePaths = attachments.filter((attachment) => attachment.kind === 'image').map((attachment) => attachment.path);
  const quotes: QuotedContext[] = [];
  if (msg.replyToMessageId) {
    const quote = await fetchQuotedContext(channel, msg.replyToMessageId);
    if (quote) quotes.push(quote);
  }
  const prompt = buildPrompt([msg], attachments, quotes);
  const trimmed = msg.content.trimStart();
  const kind = trimmed.startsWith('!') ? 'steer' : 'follow_up';
  return activeRuns.submitPrompt(scope, kind, prompt, imagePaths);
}
