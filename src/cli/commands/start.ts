import dns from 'node:dns';
import { sweepOrphanedTestWorkers } from '../../core/strays';
import { spawnSync } from 'node:child_process';
import { Client, Domain } from '@larksuiteoapi/node-sdk';
import pkg from '../../../package.json';
import { OmpAdapter } from '../../agent';
import { startChannel, type BridgeChannel } from '../../bot/channel';
import { runRegistrationWizard } from '../../bot/wizard';
import { Scheduler } from '../../scheduler';
import type { Controls } from '../../commands';
import { formatAgo } from '../../utils/time';
import { setSecret } from '../../config/keystore';
import { paths } from '../../config/paths';
import type { AppConfig } from '../../config/schema';
import {
  getOmpBinary,
  getOmpSessionDir,
  getOmpThinking,
  getOmpTools,
  isComplete,
  secretKeyForApp,
} from '../../config/schema';
import {
  buildEncryptedAccountConfig,
  ensureSecretsGetterWrapper,
  loadConfig,
  saveConfig,
} from '../../config/store';
import { gcOldLogs, log } from '../../core/logger';
import { bootout, rewritePlistThenKickstart, rotateDaemonLogsIfNeeded } from '../../daemon/launchd';
import {
  autoRestartExhausted,
  bootFailureCount,
  clearBootFailures,
  noteBootFailure,
  noteBootStarted,
  noteBootSuccess,
} from '../../daemon/boot-guard';
import { resolveAppSecret } from '../../config/secret-resolver';
import { adoptManagedCard, finalizeInterruptedCards } from '../../card/managed';
import {
  clearOnlineNotice,
  onlineReasonNote,
  recentChats,
  shouldAnnounceOrdinaryBoot,
  takeOnlineNotice,
  type OnlineBootReason,
} from '../../bot/online-notify';
import { md, onlineCard, releaseCard, restartCard, shell } from '../../card/templates';
import { RELEASE_STEPS } from '../../release/run';
import { gcMediaCache, MEDIA_GC_MAX_AGE_MS } from '../../media/cache';
import { preFlightChecks } from '../preflight';
import {
  cleanupTmpFiles,
  register,
  sameAppOthers,
  sweepStaleTmpFiles,
  unregister,
  unregisterSync,
  updateEntry,
  type ProcessEntry,
} from '../../runtime/registry';
import { SessionStore } from '../../session/store';
import { WorkspaceStore } from '../../workspace/store';

// Prefer IPv4 — Node 20+ defaults to "verbatim" which respects whatever
// the resolver returns first; in IPv6-broken networks (WSL2, certain VPNs,
// some hotel WiFi) this lands on a dead v6 route and stalls. Explicitly
// prefer v4 avoids that whole class of issue.
dns.setDefaultResultOrder('ipv4first');

// Process-level safety net: never let a stray SDK call / axios timeout
// take the whole bot down. Most outbound calls (channel.send / rawClient.*)
// are async; if any callsite misses a try/catch (or fires an update after
// its enclosing scope returned), the rejection bubbles to here. Log and
// keep the bot alive — losing a single reply is better than crashing.
process.on('unhandledRejection', (reason) => {
  log.fail('process', reason, { kind: 'unhandledRejection' });
});
process.on('uncaughtException', (err) => {
  log.fail('process', err, { kind: 'uncaughtException' });
});

/** 进入 stop() 后超过这么久仍未退出就强制 exit(1)（硬看门狗）。 */
const STOP_WATCHDOG_MS = 15_000;
/** stop() 里最多等日志轮转这么久，别让一次 copytruncate 拖住关闭。 */
const SHUTDOWN_LOG_FLUSH_MS = 2_000;
/** 孤儿自检周期。 */
const ORPHAN_CHECK_MS = 5_000;
/** 熔断告警最多等多久 —— 通知绝不能把 boot 挂住。 */
const CIRCUIT_ALERT_TIMEOUT_MS = 5_000;

/**
 * FOB_SUPERVISED=1（launchd/systemd 注入）且 ppid 变成 1：supervisor 已经死了，
 * 没有 KeepAlive 会再拉起我们，也没人会回收 —— 孤儿进程，应优雅退出。
 * 纯函数，便于测试。
 */
export function isOrphaned(ppid: number, supervised: boolean): boolean {
  return supervised && ppid === 1;
}

/** Await `p`, but never longer than `ms`; the timer is always cleared. */
async function settleWithin(p: Promise<void>, ms: number): Promise<void> {
  let timer: NodeJS.Timeout | undefined;
  try {
    await Promise.race([
      p.catch(() => {}),
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, ms);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

export interface StartOptions {
  config?: string;
  skipCheckLarkCli?: boolean;
}

export async function runStart(opts: StartOptions): Promise<void> {
  // 信号处理器必须在第一个 await 之前挂上：启动窗口（读配置 / 向导 /
  // preflight / 建连）里的 SIGINT/SIGTERM 原本走默认行为直接终止进程，
  // 什么都不清理。stop() 对尚未初始化的部分做守卫 —— bridge 没连上就跳过
  // disconnect，entry 还没注册就跳过注销；已初始化时行为与原来完全一致。
  let stopping = false;
  let entry: ProcessEntry | undefined;
  let bridge: BridgeChannel | undefined;
  // 日志轮转在下面启动；stop() 需要等它落定，先占位成已完成的 promise。
  let logRotation: Promise<void> = Promise.resolve();
  const stop = async (sig: string): Promise<void> => {
    if (stopping) {
      // 第二次 SIGINT/SIGTERM：用户/launchd 明确要求立刻退出，不能再被
      // stopping 静默吞掉（首轮 teardown 若卡住，第二次信号就该强杀）。
      log.warn('shutdown', 'second-signal', { signal: sig });
      dropSignalHandlers();
      process.exit(1);
      return;
    }
    stopping = true;
    console.log(`\n收到 ${sig}，正在关闭...`);
    // 硬看门狗：stop 内任一 await（disconnect / 注册锁等待）卡住时，
    // 15s 后强制退出，绝不让进程挂着不走。
    const watchdog = setTimeout(() => {
      log.fail('shutdown', 'stop-watchdog-timeout', { signal: sig });
      process.exit(1);
    }, STOP_WATCHDOG_MS);
    watchdog.unref();
    try {
      // 等进行中的日志轮转落定（最多 2s），否则 copytruncate 写一半就被掐断。
      await settleWithin(logRotation, SHUTDOWN_LOG_FLUSH_MS);
      try {
        // SIGTERM (launchd shutdown / external restart): don't kill OMP runs —
        // the agent may be mid-`restart` and needs to survive to re-bootstrap
        // us. OMP exits on its own when the channel (stdin pipe) closes.
        // Explicit user exit command: kill runs fast for a clean shutdown.
        await bridge?.disconnect(sig === 'exit-command');
      } catch (err) {
        console.error('[disconnect-failed]', err);
      }
      if (entry) {
        // 注册的写盘和锁释放之间有窗口：SIGTERM 若正好落在窗口里，
        // unregisterSync 会抢锁失败而静默放弃（自己的条目残留）。这里走
        // 带锁等待的异步路径；极端情况（锁忙超时）再退同步兜底。
        try {
          await unregister(entry.id);
        } catch {
          unregisterSync(entry.id);
        }
      }
    } finally {
      clearTimeout(watchdog);
    }
    dropSignalHandlers();
    process.exit(0);
  };
  // 关掉自己挂的信号处理器，避免同进程内二次 runStart（测试）或多个 stop
  // 交错时，旧实例的处理器把新实例的第二次信号当成「第二次信号」强杀。
  const onSigint = (): void => void stop('SIGINT');
  const onSigterm = (): void => void stop('SIGTERM');
  const dropSignalHandlers = (): void => {
    process.removeListener('SIGINT', onSigint);
    process.removeListener('SIGTERM', onSigterm);
  };
  process.on('SIGINT', onSigint);
  process.on('SIGTERM', onSigterm);

  const supervised = process.env.FOB_SUPERVISED === '1';

  // supervisor（launchd）若先于我们死掉，ppid 会变成 1：没有 KeepAlive 会再
  // 拉起我们，也没人会回收。定期自检；unref 的定时器不阻止正常退出。
  setInterval(() => {
    if (isOrphaned(process.ppid, supervised)) {
      log.warn('boot', 'orphaned-supervisor-gone', { ppid: process.ppid });
      void stop('orphan');
    }
  }, ORPHAN_CHECK_MS).unref();

  const configPath = opts.config ?? paths.configFile;

  // 熔断闸门：boot 最开头、任何重活之前。命中后不做任何重活，告警 + bootout
  // 让 launchd 不再每 10s 重拉，然后干净退出。
  if (await autoRestartExhausted()) {
    const failures = await bootFailureCount();
    if (supervised) {
      log.fail('boot', 'circuit-open', { failures });
      console.error(
        `✗ 连续 ${failures} 次启动失败，已停止自动重启（避免 KeepAlive 反复重拉拖垮机器）。`,
      );
      console.error('  修复后运行：feishu-omp-bridge run   （前台启动一次即恢复并清零计数）');
      console.error('  或：        feishu-omp-bridge start  （重新装入 launchd）');
      // 告警从简且绝不挂起：任一 await 卡住也只等 5s，失败只记日志。
      await settleWithin(
        alertCircuitOpen(configPath, failures).catch((err) =>
          log.warn('boot', 'circuit-alert-failed', { err: String(err) }),
        ),
        CIRCUIT_ALERT_TIMEOUT_MS,
      );
      const r = bootout();
      log.warn('boot', 'circuit-bootout', { ok: r.ok, stderr: r.stderr.slice(0, 200) });
      process.exit(0);
      return;
    }
    // 前台手动 run：用户正在主动恢复，放行并清零失败计数。
    log.warn('boot', 'circuit-open-manual-recovery', { failures });
    await clearBootFailures().catch(() => {});
  }

  // 通过闸门后记一次 boot 尝试：只要没走到 noteBootSuccess 就算失败（覆盖崩溃、
  // 超时、未捕获异常等没有显式 exit(1) 的失败）。闸门命中自身不计入，否则冻结
  // 期间计数会一直增长。
  await noteBootStarted().catch(() => {});

  // daemon-stdout/stderr 由 launchd 追加、不会滚动；启动时超阈值就 copytruncate，
  // 防止数月运行后无限膨胀。**不能 await**（会拖慢启动）；stop() 会用
  // settleWithin 等它落定（见上）。
  logRotation = rotateDaemonLogsIfNeeded().catch((err) =>
    log.warn('daemon', 'log-rotate-failed', { err: String(err) }),
  );

  // 清掉上轮崩溃/被打断留下的 *.tmp（best-effort，不 await）。
  void sweepStaleTmpFiles(paths.appDir, 3600_000).catch((err) =>
    log.warn('boot', 'tmp-sweep-failed', { err: String(err) }),
  );

  const existing = await loadConfig(configPath);

  let cfg: AppConfig;
  if (isComplete(existing)) {
    cfg = existing;
    // Migrate legacy plaintext configs: any time we see a raw string in
    // accounts.app.secret that isn't a "${VAR}" template, move it into
    // the encrypted keystore and rewrite config.json with an exec ref.
    // Idempotent — already-encrypted configs (SecretRef) pass through.
    cfg = await maybeMigratePlaintextSecret(cfg, configPath);
  } else {
    // 配置完整性校验放在 preflight / ps 全表 / GC / omp 探测之前：不完整时
    // 这些重活白付一次，KeepAlive 每 10s 重头再来会把机器拖垮。
    if (!process.stdin.isTTY) {
      // 非 TTY（launchd/systemd）无法进扫码向导：给出明确修复指令后退出。
      console.error('✗ 配置不完整，且当前不是交互终端，无法进入扫码向导。');
      console.error('  请先在终端完成一次配置：');
      console.error('    feishu-omp-bridge run');
      console.error(`  （配置文件：${configPath}）`);
      await noteBootFailure('config-incomplete').catch(() => {});
      process.exit(1);
      return;
    }
    const fresh = await runRegistrationWizard();
    // Fresh credentials from the wizard arrive as a plaintext secret;
    // immediately encrypt before persisting so disk never holds the raw value.
    cfg = await persistEncrypted(fresh, configPath);
    console.log(`配置已保存到 ${configPath}\n`);
  }

  // 单实例守卫：只需要 cfg.accounts.app.id，放在重活之前 —— 被拒时不再 ps 全表。
  // Open-platform routes events to one of the long-connections at random, so two
  // connections for the same app makes "who answered me" unpredictable (and a
  // foreground run on top of a launchd-managed daemon would double-connect).
  // Enforce a single process: refuse to start rather than offering a "kill the
  // old one" path, since the proper way to replace a running instance is
  // `restart`/`stop` (which already clean up old processes first).
  const conflicts = sameAppOthers(cfg.accounts.app.id);
  if (conflicts.length > 0) {
    // 同 job 的孤儿/前任（kickstart 杀了 supervisor 但 node 存活）若只是拒绝，
    // KeepAlive 会在每次重启时撞上它 → 无限崩溃循环、release 卡永远停在
    // 「重启中」。这里把可顶替的冲突实例 SIGTERM 掉再继续。
    const remaining = await replaceSupersededConflicts(conflicts);
    if (remaining.length > 0) {
      await noteBootFailure('duplicate-instance').catch(() => {});
      rejectDuplicates(cfg, remaining);
    }
  }

  await preFlightChecks({ skipCheckLarkCli: opts.skipCheckLarkCli });

  const agent = new OmpAdapter({
    binary: getOmpBinary(cfg),
    sessionDir: getOmpSessionDir(cfg),
    thinking: getOmpThinking(cfg),
    tools: getOmpTools(cfg),
  });
  if (!(await agent.isAvailable())) {
    console.error('✗ 未找到 omp CLI。请先安装并完成 Oh My Pi 配置：');
    console.error('  omp');
    await noteBootFailure('omp-missing').catch(() => {});
    process.exit(1);
    return;
  }

  const sessions = new SessionStore();
  await sessions.load();
  const workspaces = new WorkspaceStore();
  await workspaces.load();

  await gcMediaCache(MEDIA_GC_MAX_AGE_MS);
  await gcOldLogs();

  // 到这里所有守门都过了、确定要接管，再清上轮 /release 残留的孤儿测试
  // worker（ppid=1 且各占数 GB —— 走 ps -A 全表；失败路径绝不能走到这里）。
  sweepOrphanedTestWorkers();

  // Register self in the process registry. Cleanup is wired via stop() and
  // 'exit' below — both paths run unregisterSync so stale entries don't
  // poison the next start.
  entry = await register({
    appId: cfg.accounts.app.id,
    tenant: cfg.accounts.app.tenant,
    configPath,
    version: pkg.version,
  });
  // 闭包里（restart / exit 钩子）都用 entryId：entry 是 let，闭包内不做
  // 非空判断也拿不到收窄后的类型。
  const entryId = entry.id;
  log.info('registry', 'registered', { id: entryId, pid: process.pid });

  // `bridge` is mutable so /account can swap it on restart. `controls` carries
  // restart() and a snapshot of the current cfg so command handlers can read
  // and replace credentials without plumbing through the whole runStart scope.
  // bridge / entry 本体与 stop() 一起声明在函数最顶部（信号守卫需要）。
  let restarting = false;

  const scheduler = new Scheduler();
  await scheduler.load();

  // In-process reconnect: new channel + reloaded config, same process. Used
  // by /account, /reconnect, and the keepalive force-reconnect. Does NOT
  // reload code — for that, `restartProcess` bounces the whole process.
  const restartInProcess = async (): Promise<void> => {
    if (restarting) return;
    restarting = true;
    try {
      const next = await loadConfig(configPath);
      if (!isComplete(next)) throw new Error('config incomplete after change');
      console.log(
        `[restart] connecting new bridge with appId=${next.accounts.app.id} tenant=${next.accounts.app.tenant}...`,
      );
      // Connect-before-disconnect: if the new bridge fails to come up
      // (e.g. network outage during a force-reconnect), throwing here
      // leaves the old bridge — and its keepalive timer — untouched, so
      // the next keepalive tick (~15s later) can retry restart. Without
      // this ordering, a failed restart would tear down the only
      // keepalive in the process and the bot would never recover until
      // someone manually restarts it.
      const next_bridge = await startChannel({
        cfg: next,
        agent,
        sessions,
        workspaces,
        controls,
        scheduler,
      });
      console.log('[restart] 断开旧 bridge...');
      try {
        await bridge?.disconnect();
      } catch (err) {
        console.warn('[restart] 旧 bridge 断开失败:', err);
      }
      bridge = next_bridge;
      controls.cfg = next;
      // Keep the registry in sync so /ps reflects the new app after an
      // /account change. Same process id, new app fields.
      await updateEntry(entryId, {
        appId: next.accounts.app.id,
        tenant: next.accounts.app.tenant,
        configPath,
        botName: bridge.channel.botIdentity?.name,
      }).catch((err) =>
        log.warn('registry', 'update-failed', { err: String(err) }),
      );
      console.log('✓ 已用新凭据重连');
    } finally {
      restarting = false;
    }
  };

  const controls: Controls = {
    configPath,
    cfg,
    processId: entryId,
    scheduler,
    async exit() {
      await stop('exit-command');
    },
    async restart() {
      await restartInProcess();
    },
    async restartProcess() {
      // Bounce the whole process so the daemon relaunches with newly built
      // code. launchctl kickstart -k kills this process; KeepAlive starts
      // the fresh binary. Only meaningful under launchd — elsewhere fall
      // back to the in-process reconnect so /restart still does something.
            // 先重写 plist 再 kickstart：plist 里的 FOB_SUPERVISED/ExitTimeOut 等
      // 新参数只有重写后才生效（写失败只告警，不阻断 kickstart）。
      const result = await rewritePlistThenKickstart();
      if (!result.ok) {
        if (result.signal) {
          // launchctl died mid-report — almost certainly launchd's kickstart
          // group-kill took our own child down as it SIGTERMed us (observed
          // 4× in production as kickstart-failed with empty stderr, each
          // followed by a healthy relaunch 2s later). The pending SIGTERM
          // will stop this process; only reconnect in-process if it never
          // arrives.
          // 每次 kickstart 都走这里（launchd 的组杀会连带把 launchctl 自己带走），
          // 属**正常**路径：下一条日志/新 boot 注册即证明重启确实发生。用 info，
          // 免得 warn 级别的常规噪声掩盖真正的异常。
          log.info('restart', 'kickstart-ambiguous', { signal: result.signal });
          const fallback = setTimeout(() => {
            if (stopping) return; // SIGTERM landed; graceful stop is in flight
            log.warn('restart', 'kickstart-ambiguous-survived');
            // No boot is coming after all: drop the boot-notice marker here
            // (callers now treat this path as "restart in flight" and keep it).
            void clearOnlineNotice();
            void restartInProcess();
          }, 3000);
          fallback.unref();
          // Report TRUE: the relaunch is in flight. Returning false used to
          // make /release and /restart clear the online-notice marker and send
          // a spurious reconnect ack, so the rebooting process saw no marker
          // and announced itself with an ordinary-boot 「已上线」 card.
          return true;
        }
        log.warn('restart', 'kickstart-failed', {
          stderr: result.stderr.slice(0, 200),
          ...(result.error ? { error: result.error.slice(0, 200) } : {}),
        });
        await restartInProcess();
        return false;
      }
      return true;
    },
  };

  bridge = await startChannel({ cfg, agent, sessions, workspaces, controls, scheduler });

  // 真正接管成功：清零失败计数（成功前的失败不再计进熔断）。
  await noteBootSuccess().catch((err) =>
    log.warn('boot', 'note-success-failed', { err: String(err) }),
  );

  // Backfill the bot's display name into the registry once the WS handshake
  // is done — future starts conflicting on this app can show it in the prompt
  // ("bot 尼莫 (cli_xxx)") instead of just a short id.
  const botName = bridge?.channel.botIdentity?.name;
  if (botName) {
    await updateEntry(entryId, { botName }).catch((err) =>
      log.warn('registry', 'update-failed', { step: 'botName', err: String(err) }),
    );
  }

  // Startup notices are opt-in. `/release` leaves its final 「🚀 已发布上线」
  // card for the requesting chat, and `/restart` finalizes its tracked card —
  // both are handled below and neither broadcasts. The ordinary 「已上线」广播
  // is throttled and, since this batch, limited to recently-active chats with
  // a reason line.
  const notice = await takeOnlineNotice();

  // Crash/restart recovery: every card the previous process left in flight is
  // finalized ACCORDING TO ITS KIND (restart → 「重启完成」, streaming reply →
  // content preserved + interruption note, release → interrupted, form →
  // expired).
  const finalizedRestart = await finalizeInterruptedCards(bridge.channel, notice?.messageId).catch(
    (err) => {
      log.warn('notify', 'interrupted-finalize-failed', { err: String(err) });
      return false;
    },
  );

  // The command that bounced us confirms its own card NOW, from the new
  // process — a card must not claim「已发布上线」/「重启完成」before the new
  // process is actually up.
  if (notice?.messageId) {
    const terminal =
      notice.mode === 'skip'
        ? // Build succeeded (that's why we bounced): all steps are done.
          releaseCard({
            steps: RELEASE_STEPS.map((s) => ({ name: s.name, status: 'ok' as const })),
            phase: 'success',
          })
        : restartCard('done');
    const cardJson = JSON.stringify(terminal);
    // 命令卡是**托管卡**：消息内容只是 `{"type":"card","data":{"card_id":…}}` 的实体引用，
    // 所以更新它只有两条路：CardKit `card.update`（需要 card_id，命令层已随 marker 传过来）
    // 或重发。裸 card JSON 的 `im.message.patch` 对它无效（Historically 既不报错也不生效）。
    // 新进程没有旧进程的 sequence 计数，这里用毫秒时间戳保证严格递增。
    const viaCardKit =
      notice.cardId === undefined
        ? false
        : await bridge.channel.rawClient.cardkit.v1.card
            .update({
              path: { card_id: notice.cardId },
              data: { card: { type: 'card_json', data: cardJson }, sequence: Date.now() },
            })
            .then(() => {
              log.info('notify', 'command-card-confirmed', {
                chatId: notice.chatId,
                mode: notice.mode,
                via: 'cardkit',
              });
              return true;
            })
            .catch((err) => {
              log.warn('notify', 'command-card-confirm-failed', {
                messageId: notice.messageId,
                step: 'cardkit',
                err: String(err),
              });
              return false;
            });
    if (!viaCardKit) {
      const patched = await bridge.channel.rawClient.im.v1.message
        .patch({
          path: { message_id: notice.messageId },
          data: { content: cardJson },
        })
        .then(() => {
          log.info('notify', 'command-card-confirmed', {
            chatId: notice.chatId,
            mode: notice.mode,
            via: 'patch',
          });
          return true;
        })
        .catch((err) => {
          log.warn('notify', 'command-card-confirm-failed', {
            messageId: notice.messageId,
            err: String(err),
          });
          return false;
        });
      if (!patched) {
        // 卡片这条路走不通时至少要有一句可见回执，别让用户盯着「正在重启」。
        await bridge.channel.send(notice.chatId, { markdown: '🚀 **已上线**' }, {}).catch((err) => {
          log.warn('notify', 'online-failed', { chatId: notice.chatId, err: String(err) });
        });
      }
    }
  } else if (notice?.mode === 'notify' && !finalizedRestart) {
    // /restart requested a notice but no restart card was recovered (e.g. the
    // card was never created) — fall back to a text confirmation.
    await bridge.channel.send(notice.chatId, { markdown: '🚀 **已上线**' }, {}).catch((err) => {
      log.warn('notify', 'online-failed', { chatId: notice.chatId, err: String(err) });
    });
  }

  // 广播「已上线」：**只有完全无通知的普通启动**（含崩溃自愈）才广播；/release
  // 与 /restart 都有自己的命令卡，不广播。只发给最近有活动的会话（长期不活跃
  // 的群不再被打扰），并附上重启原因。
  if (notice === undefined) {
    const reason: OnlineBootReason = supervised ? 'crash-recovery' : 'manual';
    // Throttle: a crash loop would otherwise re-announce to every chat on each
    // boot. Stay silent if we announced within the window.
    if (await shouldAnnounceOrdinaryBoot()) {
      // Only real chat ids are valid receive_ids: session keys are scopes, and
      // cloud-doc comments (`doc:…`) / topic chats (`chatId:threadId`) would
      // fail every boot. `recentChats` drops the long-inactive ones.
      const targets = recentChats(
        sessions.chats(),
        (id) => sessions.getRaw(id)?.updatedAt,
        Date.now(),
      ).filter((id) => /^(oc_|cg_)/.test(id) && !id.includes(':'));
      const card = onlineCard(onlineReasonNote(reason));
      for (const chatId of targets) {
        await bridge.channel
          .send(chatId, { card }, {})
          .then(() => log.info('notify', 'online', { chatId, reason }))
          .catch((err) => log.warn('notify', 'online-failed', { chatId, err: String(err) }));
      }
    } else {
      log.info('notify', 'online-throttled', { reason: 'ordinary-boot-window' });
    }
  }
  // SIGINT/SIGTERM 在 runStart 顶部就已注册（启动窗口也要能优雅退出），
  // 这里不再重复挂。最后兜底：同步注销 + 清临时文件，防止不走 stop() 的
  // 退出路径（如 uncaughtException 里的 process.exit(1)）留下脏注册表。
  process.on('exit', () => {
    unregisterSync(entryId);
    cleanupTmpFiles();
  });

  // keep the event loop alive until a signal arrives
  await new Promise<void>(() => {});
}

/**
 * Print the same-app conflict, then ask the user how to proceed. Returns
 * true to continue starting (after killing the old ones), false to cancel.
 *
 * Non-TTY (launchd / systemd / piped) skips the prompt and warns — a service
 * manager can't answer questions, and erroring out by default would surprise
 * users running a daemon.
 */
/**
 * 判断一个同应用的存活实例能否被当前启动直接顶替：
 * - `FOB_SUPERVISED=1`（launchd plist / systemd unit 注入）：守护接管一切，含前台
 *   实例 —— 接管语义本来就如此，且双连接必须避免；
 * - 否则只顶替**孤儿**（ppid=1，supervisor 已死但 node 存活）或已消失的条目
 *   （readAndPrune 竞态）；前台 `run`（父进程是活着的终端）保持守卫本意，不顶替。
 */
export function isReplaceableConflict(
  entry: ProcessEntry,
  ppidOf: (pid: number) => number | undefined,
  supervised: boolean,
): boolean {
  if (supervised) return true;
  const ppid = ppidOf(entry.pid);
  return ppid === 1 || ppid === undefined;
}

async function waitForProcessExit(pid: number, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    let alive = true;
    try {
      process.kill(pid, 0);
    } catch {
      alive = false;
    }
    if (!alive) return true;
    if (Date.now() >= deadline) return false;
    await new Promise((r) => setTimeout(r, 100));
  }
}

/**
 * SIGTERM 可顶替的冲突实例并等它退出（不退则 SIGKILL 兜底），返回仍然
 * 存活的实例 —— 非空则调用方照旧拒绝启动。
 */
export async function replaceSupersededConflicts(
  conflicts: ProcessEntry[],
  opts: { supervised?: boolean; timeoutMs?: number } = {},
): Promise<ProcessEntry[]> {
  const supervised = opts.supervised ?? process.env.FOB_SUPERVISED === '1';
  const ppidOf = (pid: number): number | undefined => {
    const r = spawnSync('ps', ['-o', 'ppid=', '-p', String(pid)], { encoding: 'utf8' });
    const n = Number.parseInt((r.stdout ?? '').trim(), 10);
    return Number.isFinite(n) ? n : undefined;
  };
  for (const e of conflicts) {
    if (!isReplaceableConflict(e, ppidOf, supervised)) continue;
    console.log(`顶替旧实例 ${e.id}（pid ${e.pid}）：同一守护任务的孤儿/前任，先 SIGTERM。`);
    try {
      process.kill(e.pid, 'SIGTERM');
    } catch {
      /* 已经死了 */
    }
    if (!(await waitForProcessExit(e.pid, opts.timeoutMs ?? 8000))) {
      console.warn(`旧实例 ${e.pid} 未按期退出，升级 SIGKILL。`);
      try {
        process.kill(e.pid, 'SIGKILL');
      } catch {
        /* 已经死了 */
      }
      await waitForProcessExit(e.pid, 2000);
    }
    console.log(`旧实例 ${e.pid} 已退出，由当前实例接管。`);
  }
  return conflicts.filter((e) => {
    try {
      process.kill(e.pid, 0);
      return true;
    } catch {
      return false;
    }
  });
}

/**
 * Refuse to start when the same Feishu app already has a live process.
 * Enforces single-process: the app's events would be routed to whichever
 * connection answers, so a second connection is always wrong. The user
 * should use `restart` (cleanly replaces) or `stop` + `run` instead.
 */
function rejectDuplicates(cfg: AppConfig, conflicts: ProcessEntry[]): never {
  console.error(
    `✗ 检测到飞书应用 ${cfg.accounts.app.id} 已经有 ${conflicts.length} 个 bot 正在运行，拒绝重复启动。`,
  );
  for (const e of conflicts) {
    const ago = formatAgo(Date.now() - new Date(e.startedAt).getTime());
    const label = e.botName ? `bot ${e.botName} (${e.appId})` : `bot ${e.appId}`;
    console.error(`  - ${label},进程 ${e.id},${ago}启动`);
  }
  console.error('');
  console.error('单进程约束：同一应用只允许一个连接（飞书事件随机路由，多连接会"谁应答"不确定）。');
  console.error('');
  console.error('要替换当前实例，请用：');
  console.error('  feishu-omp-bridge restart   # 干净替换(先停旧的再起新的)');
  console.error('  feishu-omp-bridge stop      # 停止后,再 run / start');
  console.error('  feishu-omp-bridge kill <id> # 或按 /ps 显示的 id 关掉指定进程');
  process.exit(1);
}

/**
 * 熔断命中时尽力告诉用户一次。从简：能读到 config + sessions 里某个真实 chat
 * 就用 SDK 直发一张说明卡；任何一步失败只记日志（由调用方 catch），绝不因此
 * 挂起 boot。
 */
async function alertCircuitOpen(configPath: string, failures: number): Promise<void> {
  const cfg = await loadConfig(configPath);
  if (!isComplete(cfg)) return;
  const sessions = new SessionStore();
  await sessions.load();
  const chatId = sessions
    .chats()
    .find((id) => /^(oc_|cg_)/.test(id) && !id.includes(':'));
  if (!chatId) return;
  const appSecret = await resolveAppSecret(cfg);
  const client = new Client({
    appId: cfg.accounts.app.id,
    appSecret,
    domain: cfg.accounts.app.tenant === 'lark' ? Domain.Lark : Domain.Feishu,
    source: 'feishu-omp-bridge',
  });
  await client.im.v1.message.create({
    params: { receive_id_type: 'chat_id' },
    data: {
      receive_id: chatId,
      msg_type: 'interactive',
      content: JSON.stringify(
        shell('⚠️ 启动熔断', [
          md('⚠️ **启动熔断：已停止自动重启**', 'heading'),
          md(`连续 **${failures}** 次启动失败。为避免反复重启拖垮机器，已从 launchd 卸载。`),
          md('修复后请运行 `feishu-omp-bridge run`（前台启动一次即可恢复）。'),
        ]),
      ),
    },
  });
}

/**
 * If `cfg.accounts.app.secret` is a literal plaintext string (not a
 * "${VAR}" template, not a SecretRef), move it into the encrypted keystore
 * and rewrite `config.json` with an exec-provider SecretRef pointing at
 * the bridge. Returns the (possibly rewritten) cfg.
 *
 * Idempotent: configs already in the encrypted form return unchanged.
 */
async function maybeMigratePlaintextSecret(
  cfg: AppConfig,
  configPath: string,
): Promise<AppConfig> {
  const s = cfg.accounts.app.secret;

  // Path A: still plaintext → encrypt + rewrite config.
  if (typeof s === 'string' && !/^\$\{[A-Z][A-Z0-9_]*\}$/.test(s)) {
    try {
      const next = await buildEncryptedAccountConfig(
        cfg.accounts.app.id,
        cfg.accounts.app.tenant,
        cfg.preferences,
      );
      await setSecret(secretKeyForApp(cfg.accounts.app.id), s);
      await saveConfig(next, configPath);
      console.log('🔒 已把 App Secret 加密迁移到 ~/.feishu-omp-bridge/secrets.enc');
      return next;
    } catch (err) {
      log.warn('config', 'migrate-encrypted-failed', {
        err: err instanceof Error ? err.message : String(err),
      });
      // Migration failure isn't fatal — runtime resolver still handles
      // the plaintext path.
      return cfg;
    }
  }

  // Path B: env-template — leave entirely alone.
  if (typeof s === 'string') return cfg;

  // Path C: already a SecretRef. Two things to keep fresh:
  //   1. The wrapper script content (node / bridge paths may have moved).
  //   2. The config's `secrets.providers.bridge` block — older bridge
  //      versions wrote `command: <node path>`; the new format points
  //      at the wrapper. Rewrite if out of date so lark-cli's audit
  //      sees a user-owned, non-symlinked command path.
  try {
    const wrapperPath = await ensureSecretsGetterWrapper();
    if (needsProviderRewrite(cfg, wrapperPath)) {
      const next = await buildEncryptedAccountConfig(
        cfg.accounts.app.id,
        cfg.accounts.app.tenant,
        cfg.preferences,
      );
      await saveConfig(next, configPath);
      console.log('🔒 已把 secrets provider 切到 wrapper 形态');
      return next;
    }
  } catch (err) {
    log.warn('config', 'wrapper-refresh-failed', {
      err: err instanceof Error ? err.message : String(err),
    });
  }
  return cfg;
}

function needsProviderRewrite(cfg: AppConfig, wrapperPath: string): boolean {
  const provider = cfg.secrets?.providers?.bridge;
  if (!provider) return true;
  if (provider.command !== wrapperPath) return true;
  if (!Array.isArray(provider.args) || provider.args.length !== 0) return true;
  return false;
}

/** Encrypt the (plaintext) secret from a freshly-wizard'd cfg and persist. */
async function persistEncrypted(cfg: AppConfig, configPath: string): Promise<AppConfig> {
  const s = cfg.accounts.app.secret;
  if (typeof s !== 'string') {
    // Wizard returns plaintext today; if that ever changes, just save as-is.
    await saveConfig(cfg, configPath);
    return cfg;
  }
  const next = await buildEncryptedAccountConfig(
    cfg.accounts.app.id,
    cfg.accounts.app.tenant,
    cfg.preferences,
  );
  await setSecret(secretKeyForApp(cfg.accounts.app.id), s);
  await saveConfig(next, configPath);
  return next;
}

