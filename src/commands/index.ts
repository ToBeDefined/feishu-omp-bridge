import type { LarkChannel, NormalizedMessage } from '@larksuiteoapi/node-sdk';
import type { AgentAdapter } from '../agent/types';
import type { ActiveRuns } from '../bot/active-runs';
import type { AppConfig } from '../config/schema';
import { isAdmin } from '../config/schema';
import { log } from '../core/logger';
import type { SessionStore } from '../session/store';
import type { WorkspaceStore } from '../workspace/store';
import { accountHandlers } from './account';
import { lifecycleHandlers } from './lifecycle';
import { modelHandlers } from './model';
import { sessionHandlers } from './session';
import type { Scheduler } from '../scheduler';

export interface Controls {
  /** Restart the bridge in-process: disconnect WS, kill OMP runs, reload
   * config, reconnect with the new credentials. */
  restart(): Promise<void>;
  /** True process restart: ask launchd to kill this process so the daemon
   * relaunches with newly built code. Returns false when not running under
   * launchd (caller falls back to in-process `restart`). */
  restartProcess(): Promise<boolean>;
  /** Stop this whole process gracefully (disconnect + exit). Used by /exit
   * when the user targets the receiving process itself. */
  exit(): Promise<void>;
  /** Path to the config file the bridge was started with. */
  configPath: string;
  /** The current app config (snapshot at startChannel time). */
  cfg: AppConfig;
  /** This process's short id in the registry. Used by /ps to highlight the
   * receiving process and by /exit to detect self-target. */
  processId: string;
  /** Task scheduler for /every scheduled runs. */
  scheduler?: Scheduler;
}

export interface CommandContext {
  channel: LarkChannel;
  msg: NormalizedMessage;
  /**
   * Session scope string. For p2p / regular group it equals `msg.chatId`;
   * for topic groups it's `${chatId}:${threadId}` (so each topic gets its
   * own session / cwd / active-run). All handlers should read/write
   * session / workspace / activeRuns through this — never through
   * `msg.chatId` directly.
   */
  scope: string;
  /** Resolved chat mode for `msg.chatId`. Used by /status to surface the
   * scope semantic to the user (`topic` shows "话题独立 session"). */
  chatMode: 'p2p' | 'group' | 'topic';
  sessions: SessionStore;
  workspaces: WorkspaceStore;
  agent: AgentAdapter;
  activeRuns: ActiveRuns;
  controls: Controls;
  /** Set when invoked from a CardKit 2.0 form submit. Keys are input `name`s. */
  formValue?: Record<string, unknown>;
  /** True when this invocation came from a card button click rather than a
   * text command. Determines whether to update the existing card vs send a
   * new one. */
  fromCardAction?: boolean;
}

export type Handler = (args: string, ctx: CommandContext) => Promise<void>;

/** All slash commands, merged from per-domain handler modules. */
const handlers: Record<string, Handler> = {
  ...sessionHandlers,
  ...modelHandlers,
  ...lifecycleHandlers,
  ...accountHandlers,
};

/**
 * Commands that can mutate credentials, lifecycle, filesystem reach, or
 * surface sensitive runtime state. Gated on the configured admin allowlist;
 * empty list = no restriction (every allowed user can run them — see
 * `isAdmin` in config/schema).
 */
const ADMIN_COMMANDS: Record<string, true> = {
  '/account': true,
  '/config': true,
  '/model': true,
  '/thinking': true,
  '/think': true,
  '/restart': true,
  '/context': true,
  '/ctx': true,
  '/resume': true,
  '/session': true,
  '/every': true,
  '/search': true,
  '/s': true,
  '/exit': true,
  '/reconnect': true,
  '/doctor': true,
  '/cd': true,
  '/ws': true,
};

function isAdminCommand(cmd: string): boolean {
  return ADMIN_COMMANDS[cmd.startsWith('/') ? cmd : `/${cmd}`] === true;
}

/**
 * Run a handler with a uniform error net: a thrown handler error is logged
 * (tagged with the command) and swallowed — a crash in one slash command
 * must not take down the whole bridge. Returns whether the command existed
 * and was invoked.
 */
async function runHandler(
  cmd: string,
  args: string,
  h: Handler,
  ctx: CommandContext,
): Promise<boolean> {
  try {
    await h(args, ctx);
  } catch (err) {
    log.fail('command', err, { cmd });
  }
  return true;
}

export async function tryHandleCommand(ctx: CommandContext): Promise<boolean | 'denied'> {
  const trimmed = ctx.msg.content.trim();
  if (!trimmed.startsWith('/')) return false;
  const parts = trimmed.split(/\s+/);
  const cmd = parts[0] ?? '';
  const args = parts.slice(1).join(' ');
  const h = handlers[cmd];
  if (!h) return false;
  if (isAdminCommand(cmd) && !isAdmin(ctx.controls.cfg, ctx.msg.senderId)) {
    log.info('command', 'admin-deny', {
      cmd,
      sender: ctx.msg.senderId.slice(-6),
    });
    // 'denied' is truthy so callers treat the input as consumed, but lets
    // intake distinguish "ran" from "rejected" and skip reset side effects.
    return 'denied';
  }
  return runHandler(cmd, args, h, ctx);
}

/**
 * Invoke a named command handler (e.g. from a card button click).
 * Returns false for unknown commands, `'denied'` when an admin command was
 * silently rejected (still "handled" — truthy — so callers treat the input
 * as consumed), and true when a handler actually ran.
 */
export type CommandRunResult = boolean | 'denied';

export async function runCommandHandler(
  name: string,
  args: string,
  ctx: CommandContext,
): Promise<CommandRunResult> {
  const h = handlers[`/${name}`];
  if (!h) return false;
  if (isAdminCommand(name) && !isAdmin(ctx.controls.cfg, ctx.msg.senderId)) {
    log.info('command', 'admin-deny', {
      cmd: name,
      sender: ctx.msg.senderId.slice(-6),
      via: 'card',
    });
    // Card actions can't reply naturally (the `msg` is synthesized); the
    // click is silently denied. The button only renders for users who got
    // the original admin card in the first place, so this is an edge case.
    return 'denied';
  }
  return runHandler(`/${name}`, args, h, ctx);
}
