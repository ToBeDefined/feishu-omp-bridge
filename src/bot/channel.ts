import type {
  LarkChannel,
  LarkChannelOptions,
} from '@larksuiteoapi/node-sdk';
import { Domain, LoggerLevel, createLarkChannel } from '@larksuiteoapi/node-sdk';
import type { AgentAdapter } from '../agent/types';
import { handleCardAction } from '../card/dispatcher';
import type { Controls } from '../commands';
import type { AppConfig } from '../config/schema';
import { getMaxConcurrentRuns } from '../config/schema';
import { resolveAppSecret } from '../config/secret-resolver';
import { log, withTrace } from '../core/logger';
import { MediaCache } from '../media/cache';
import type { SessionStore } from '../session/store';
import type { WorkspaceStore } from '../workspace/store';
import { ActiveRuns } from './active-runs';
import { ChatModeCache } from './chat-mode-cache';
import { handleCommentMention } from './comments';
import { intakeMessage } from './intake';
import { resolveOwner } from './owner';
import { startKeepalive } from './keepalive';
import { configureNetwork } from './network-config';
import { PendingQueue } from './pending-queue';
import { ProcessPool } from './process-pool';
import { runAgentBatch, runScheduledPrompt } from './batch';
import type { Scheduler } from '../scheduler';

const DEBOUNCE_MS = 600;

// Lark SDK logs API errors at error level even when the caller catches them.
// These specific codes are EXPECTED in our flow (wiki-node lookup that
// usually misses, fileComment.get that we deliberately let fall back to
// .list) and the surrounding noise is already covered by our own logs.
const SUPPRESSED_API_ERROR_CODES = new Set([
  131005, // wiki.space.getNode "not found" — the doc isn't a wiki node
  1069307, // drive.fileComment.get "not exist" — fall back to .list
  1069302, // drive.fileCommentReply.create — whole-doc comments don't accept replies; fall back to fileComment.create
]);

function buildQuietLogger(): {
  error: (...m: unknown[]) => void;
  warn: (...m: unknown[]) => void;
  info: (...m: unknown[]) => void;
  debug: (...m: unknown[]) => void;
  trace: (...m: unknown[]) => void;
} {
  // Match either `{ code: <feishu-code> }` (the response data SDK logs as
  // its second arg) or an AxiosError where the feishu code lives at
  // `err.response.data.code` (which the SDK logs raw).
  const codeFromObj = (m: unknown): number | undefined => {
    if (!m || typeof m !== 'object') return undefined;
    const top = (m as { code?: unknown }).code;
    if (typeof top === 'number') return top;
    const nested = (m as { response?: { data?: { code?: unknown } } })?.response?.data?.code;
    return typeof nested === 'number' ? nested : undefined;
  };
  const isSuppressed = (msg: unknown): boolean => {
    if (Array.isArray(msg)) return msg.some(isSuppressed);
    const code = codeFromObj(msg);
    return code !== undefined && SUPPRESSED_API_ERROR_CODES.has(code);
  };
  return {
    error: (...args: unknown[]) => {
      if (args.some(isSuppressed)) return;
      log.warn('sdk', 'error', { args: stringifyArgs(args) });
    },
    warn: (...args: unknown[]) => log.warn('sdk', 'warn', { args: stringifyArgs(args) }),
    info: (...args: unknown[]) => log.info('sdk', 'info', { args: stringifyArgs(args) }),
    debug: () => {},
    trace: () => {},
  };
}

function stringifyArgs(args: unknown[]): string {
  return args
    .map((a) => {
      if (typeof a === 'string') return a;
      try {
        return JSON.stringify(a);
      } catch {
        return String(a);
      }
    })
    .join(' ');
}

export interface BridgeChannel {
  channel: LarkChannel;
  disconnect(killRuns?: boolean): Promise<void>;
}

export interface StartChannelDeps {
  cfg: AppConfig;
  agent: AgentAdapter;
  sessions: SessionStore;
  workspaces: WorkspaceStore;
  controls: Controls;
  scheduler?: Scheduler;
}

export async function startChannel(deps: StartChannelDeps): Promise<BridgeChannel> {
  const { cfg, agent, sessions, workspaces, controls, scheduler } = deps;
  const activeRuns = new ActiveRuns();
  // ChatModeCache stays per-bridge-instance — invalidated on restart along
  // with everything else. Topic-mode chats only need one chat.get() call ever.
  const chatModeCache = new ChatModeCache();
  // Concurrency cap — reads `preferences.maxConcurrentRuns` on each acquire,
  // so /config bumps take effect for the next run.
  const pool = new ProcessPool(() => getMaxConcurrentRuns(controls.cfg));

  // Apply network-layer overrides (HTTP timeout + proxy from env). Idempotent;
  // safe to call on every startChannel (used by /account change hot-reload too).
  const netOverrides = configureNetwork();

  // Resolve the App Secret to plaintext. The config field can be a literal
  // string, a "${VAR}" template, or a {source, id} SecretRef referencing
  // the encrypted keystore / env / file / exec provider. Re-resolved on
  // every startChannel so /account change picks up new secrets.
  const appSecret = await resolveAppSecret(cfg);

  const opts: LarkChannelOptions = {
    appId: cfg.accounts.app.id,
    appSecret,
    domain: cfg.accounts.app.tenant === 'lark' ? Domain.Lark : Domain.Feishu,
    source: 'feishu-omp-bridge',
    loggerLevel: LoggerLevel.info,
    logger: buildQuietLogger(),
    policy: {
      dmMode: 'open',
      requireMention: false,
      respondToMentionAll: false,
    },
    // Disable per-chat serialization so we can implement our own
    // debounce + run-chain policy (see pending-queue + runChain below).
    safety: {
      chatQueue: { enabled: false },
    },
    // Attach raw Feishu event body to normalized events so we can read fields
    // the normalizer drops (e.g. action.form_value on CardKit 2.0 form submits).
    includeRawEvent: true,
    outbound: {
      streamThrottleMs: 400,
    },
    // SDK 1.65.0-alpha.3+ knobs.
    wsConfig: {
      // 3s liveness watchdog: if no inbound message arrives within 3s after
      // the last ping, SDK presumes connection dead and forces a reconnect.
      pingTimeout: 3,
    },
    // 8s handshake timeout (replaces hardcoded 15s). Fast-fail + fast-retry
    // beats slow-fail in unstable networks.
    handshakeTimeoutMs: 8_000,
    // Optional WS-layer proxy agent (only when HTTPS_PROXY / HTTP_PROXY env set).
    ...(netOverrides.agent ? { agent: netOverrides.agent } : {}),
  };

  const channel = createLarkChannel(opts);
  // Auto-detect the bot owner (Feishu app creator_id) before the channel
  // starts serving messages; in-memory only, best-effort.
  await resolveOwner(channel, cfg);
  const media = new MediaCache(channel);

  // Pending → run handoff: while a run is active on a chat, block its pending
  // queue so messages keep accumulating without flushing. When the run ends,
  // unblock arms a fresh quiet-window timer. Net effect: at most one run per
  // chat in flight, and everything sent during a run merges into the next
  // batch (only flushed once 600ms of silence has passed *after* the run).
  const pending = new PendingQueue(DEBOUNCE_MS, (scope, batch) => {
    const firstMsg = batch[0];
    if (!firstMsg) return;
    pending.block(scope);
    void withTrace({ chatId: firstMsg.chatId }, async () => {
      log.info('flush', 'start', { scope, batchSize: batch.length });
      // Pool slot acquired here, released in finally. Across-the-bridge cap.
      const release = await pool.acquire();
      try {
        const mode = await chatModeCache.resolve(channel, firstMsg.chatId);
        await runAgentBatch({
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
        });
      } catch (err) {
        log.fail('flush', err);
      } finally {
        release();
        pending.unblock(scope);
        log.info('flush', 'end');
      }
    });
  });

  // Counter for stdout reconnect escalation; reset on `reconnected`.
  let consecutiveReconnects = 0;

  channel.on({
    message: async (msg) => {
      await withTrace({ chatId: msg.chatId, msgId: msg.messageId }, () =>
        intakeMessage({
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
        }),
      ).catch((err) => log.fail('intake', err));
    },
    reject: (evt) => {
      log.info('intake', 'reject', { chatId: evt.chatId, reason: evt.reason });
    },
    cardAction: async (evt) => {
      await withTrace({ chatId: evt.chatId, msgId: evt.messageId }, async () => {
        await handleCardAction({
          channel,
          evt,
          sessions,
          workspaces,
          activeRuns,
          agent,
          controls,
          pending,
          chatModeCache,
        });
      }).catch((err) => log.fail('cardAction', err));
    },
    comment: async (evt) => {
      await withTrace({ chatId: 'comment' }, async () => {
        await handleCommentMention({ channel, evt, agent, sessions, workspaces, cfg }).catch((err) =>
          log.fail('comment', err),
        );
      }).catch((err) => log.fail('comment', err));
    },
    reconnecting: () => {
      consecutiveReconnects++;
      log.warn('ws', 'reconnecting', { consecutive: consecutiveReconnects });
      // Stdout escalation — surface jitter that's hidden in the file log.
      if (consecutiveReconnects === 3) {
        console.error('⚠️ 已连续重连 3 次,网络可能不稳。');
      } else if (consecutiveReconnects === 10) {
        console.error('❌ 已连续重连 10 次,建议在飞书发 /reconnect 或重启 bot。');
      }
    },
    reconnected: () => {
      if (consecutiveReconnects > 1) {
        log.info('ws', 'recovered', { afterAttempts: consecutiveReconnects });
      } else {
        log.info('ws', 'reconnected');
      }
      consecutiveReconnects = 0;
    },
    // Classify common WS errors into the `network` phase so /doctor and grep
    // can find them without scanning generic `ws.fail` entries.
    error: (err) => {
      const msg = err?.message ?? String(err);
      if (/ENOTFOUND|getaddrinfo/.test(msg)) {
        log.fail('network', err, { kind: 'dns', code: err.code });
      } else if (/handshake|did not complete/.test(msg)) {
        log.fail('network', err, { kind: 'handshake-timeout', code: err.code });
      } else if (/timeout/i.test(msg)) {
        log.fail('network', err, { kind: 'timeout', code: err.code });
      } else {
        log.fail('ws', err, { code: err.code });
      }
    },
  });

  await channel.connect();

  const identity = channel.botIdentity;
  log.info('ws', 'connected', {
    bot: identity?.name ?? 'unknown',
    openId: identity?.openId ?? '-',
    agent: `${agent.displayName} (${agent.id})`,
    appId: cfg.accounts.app.id,
    procId: controls.processId,
  });
  console.log('正在监听消息。按 Ctrl+C 退出。\n');

  // App-level keepalive: 15s probe + wake-up detection + HTTP reachability.
  // Defense-in-depth — the SDK's pingTimeout watchdog handles half-dead WS,
  // this catches anything that the SDK misses (silent state stuck, etc.).
  const probeDomain =
    cfg.accounts.app.tenant === 'lark'
      ? 'https://open.larksuite.com'
      : 'https://open.feishu.cn';
  const keepalive = startKeepalive({
    channel,
    domain: probeDomain,
    forceReconnect: () => controls.restart(),
  });

  // Scheduled tasks: wire the scheduler to actually run an agent prompt and
  // stream the result to the task's chat. The scheduler lives on controls so
  // /every can add/list/remove tasks from inside a command handler.
  if (scheduler) {
    scheduler.setHandler((task) => {
      // Don't clobber an in-flight run in this chat: firing a scheduled
      // prompt while the user is mid-conversation would overwrite the run's
      // handle (breaking /stop) and run two agents against the same session.
      // Skip this tick; the next interval will try again.
      if (activeRuns.hasAnyForChat(task.chatId)) {
        log.info('scheduler', 'skip-busy', { chatId: task.chatId, id: task.id });
        return;
      }
      void runScheduledPrompt({
        channel,
        agent,
        sessions,
        workspaces,
        activeRuns,
        controls,
        chatId: task.chatId,
        prompt: task.prompt,
      }).catch((err) => log.fail('scheduler', err, { id: task.id }));
    });
    scheduler.start();
  }

  return {
    channel,
    disconnect: async (killRuns = true) => {
      keepalive.stop();
      // Scheduler 是进程级资源（runStart 创建一次），不属于单次连接：
      // 进程内 restart（先 startChannel 新桥再 disconnect 旧桥）若在此 stop，
      // 共享 scheduler 的 timer 会被旧桥拆掉且新桥的 start() 因幂等不重建，
      // 定时任务从此停摆直到进程重启。timer 已 unref，进程退出不受阻。
      pending.cancelAll();
      await channel.disconnect();
      // When we're being shut down by launchd / an external `restart`
      // (SIGTERM), DON'T actively kill OMP runs. Closing the channel closes
      // OMP's stdin pipe → OMP sees EOF and exits on its own. Killing OMP
      // here would also kill the agent-run `restart` command (its child
      // bash), leaving the daemon bootout'd with no one to re-bootstrap it.
      // For an explicit user `exit` command (killRuns=true), kill fast.
      if (killRuns) await activeRuns.stopAll();
      await Promise.allSettled([sessions.flush(), workspaces.flush()]);
    },
  };
}
