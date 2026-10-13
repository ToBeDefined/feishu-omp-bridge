import type { CommandContext, Handler } from '../index';
import { parseForceArg, reply, RESTART_FLUSH_GRACE_MS } from '../shared';
import { log } from '../../core/logger';
import {
  repoRoot,
  runRelease,
  RELEASE_STEPS,
  type ReleaseResult,
  type ReleaseStepName,
} from '../../release/run';
import { clearOnlineNotice, markOnlineNotice } from '../../bot/online-notify';
import {
  releaseCard,
  type ReleaseProgress,
  type ReleaseStepState,
} from '../../card/templates';
import { managedSequence, sendManagedCard, updateManagedCard } from '../../card/managed';

let inFlight = false;

/** 发布/重启前等待在跑的 run 排空的上限。超时就不再等（兜底补卡逻辑仍在），
 * 但会把它写进日志与卡片，免得用户以为「什么都没发生」。 */
export const RELEASE_DRAIN_MAX_MS = 5 * 60_000;

/** 轮询间隔：只在空闲判断上花的时间，不是卡片更新频率（见 `DRAIN_REPORT_MIN_MS`）。 */
const DRAIN_POLL_MS = 500;

/** `onWait` 的最小上报间隔：卡片 patch 有配额，不能每个轮询都写一遍。 */
const DRAIN_REPORT_MIN_MS = 2000;

/** `waitForRunsToDrain` 需要的 activeRuns 视图（`ActiveRuns` 直接满足）。 */
export interface DrainableRuns {
  idle(): boolean;
  runningCount(): number;
}

/** 排空等待的进度快照，喂给 {@link DrainOptions.onWait}。 */
export interface DrainProgress {
  /** 当前在跑的 run 数（含已占位未起跑）。 */
  runningCount: number;
  /** 从开始等待算起已经过去的毫秒数。 */
  waitedMs: number;
  /** 本次等待的上限毫秒数。 */
  timeoutMs: number;
}

export interface DrainOptions {
  /**
   * 等待期间的进度回调：进入等待时立刻一次，之后**至少间隔
   * {@link DRAIN_REPORT_MIN_MS}** 才再报一次。调用方据此更新卡片，
   * 不能等半天卡片上一片空白。
   */
  onWait?: (progress: DrainProgress) => void | Promise<void>;
}

/**
 * 等到进程内没有在跑的 run 再重启。kickstart 会连带杀掉正在执行的 OMP run：
 * 那条消息已经被 ack、队列又只在内存里，重启后就**彻底丢了**（实测一次发布
 * 吞掉一个提问），还会给它的卡片补一条「进程中断」。
 *
 * `options.onWait` 让这段最长 5 分钟的等待在卡片上可见（含在跑数量与已等时长）。
 */
export async function waitForRunsToDrain(
  activeRuns: DrainableRuns,
  timeoutMs: number = RELEASE_DRAIN_MAX_MS,
  options: DrainOptions = {},
): Promise<boolean> {
  const { onWait } = options;
  const startedAt = Date.now();
  const deadline = startedAt + timeoutMs;
  // 负数起步：第一次进循环必须立即上报，之后才按节流间隔走。
  let lastReportAt = -Infinity;
  while (!activeRuns.idle()) {
    const now = Date.now();
    if (now - lastReportAt >= DRAIN_REPORT_MIN_MS) {
      lastReportAt = now;
      await onWait?.({
        runningCount: activeRuns.runningCount(),
        waitedMs: now - startedAt,
        timeoutMs,
      });
    }
    if (now >= deadline) return false;
    // Executor form: tsconfig lib 是 ES2022，`Promise.withResolvers` 需要 Node 22+（本包支持 20+）。
    await new Promise((r) => setTimeout(r, DRAIN_POLL_MS));
  }
  return true;
}

export const releaseHandlers: Record<string, Handler> = {
  '/release': handleRelease,
};

function failureNote(result: ReleaseResult): string {
  if (result.pnpmMissing) return '找不到 pnpm，请确认 PATH 里可用。';
  if (result.timedOut) return '执行超时。';
  return result.exitCode !== undefined ? `退出码 ${result.exitCode}` : '未知错误';
}

async function handleRelease(args: string, ctx: CommandContext): Promise<void> {
  const parsed = parseForceArg(args, '/release [force]');
  if (!parsed.ok) {
    await reply(ctx, parsed.message);
    return;
  }
  const { force } = parsed;
  if (inFlight) {
    await reply(ctx, '⚠️ 已有一次发布正在进行，请稍候。');
    return;
  }
  inFlight = true;
  const steps = RELEASE_STEPS.map((s) => ({ name: s.name, status: 'pending' as ReleaseStepState }));
  let messageId: string | undefined;
  let cardId: string | undefined;
  // 排空阶段的状态：由 waitForRunsToDrain 的回调刷新，push 时带上。
  let drain: ReleaseProgress['drain'];
  // force 时重启会中断的在跑 run 数：在决定跳过排空的那一刻数，卡片上写明代价。
  let interruptedCount: number | undefined;
  const push = async (): Promise<void> => {
    const card = releaseCard({
      steps,
      phase: 'running',
      forced: force,
      ...(drain ? { drain } : {}),
    });
    if (!messageId) {
      const sent = await sendManagedCard(ctx.channel, ctx.msg.chatId, card, ctx.msg.messageId, {
        track: true,
        kind: 'release',
      });
      messageId = sent.messageId;
      cardId = sent.cardId;
    } else {
      await updateManagedCard(ctx.channel, messageId, card);
    }
  };
  const close = async (
    phase: 'success' | 'restarting' | 'failed',
    failNote?: string,
    output?: string,
  ): Promise<void> => {
    if (!messageId) return;
    await updateManagedCard(
      ctx.channel,
      messageId,
      releaseCard({
        steps,
        phase,
        forced: force,
        ...(interruptedCount !== undefined ? { interruptedCount } : {}),
        // 排空超时也要留在**重启前最后一张卡**上（running 那张随后会被
        // restarting 覆盖）：新进程只确认「已发布上线」，看不到这段。
        ...(drain?.timedOut ? { drain } : {}),
        ...(phase === 'failed'
          ? { failStep: failingStep, failNote, output }
          : {}),
      }),
    );
  };
  let failingStep: ReleaseStepName | undefined;
  try {
    const onStep = async (step: ReleaseStepName, status: ReleaseStepState): Promise<void> => {
      const found = steps.find((s) => s.name === step);
      if (found) found.status = status;
      if (status === 'failed') failingStep = step;
      await push().catch((err) => log.fail('command', err, { step: 'release-card' }));
    };
    await push().catch(() => {});
    const result = await runRelease(undefined, repoRoot(), onStep);
    if (!result.ok) {
      await close('failed', failureNote(result), result.output).catch(
        (err) => log.fail('command', err, { step: 'release-card' }),
      );
      return;
    }
    // 先等在跑的 run 收尾再重启：kickstart 会杀掉它们，消息在内存队列里、
    // 重启后无法恢复（等于静默丢失）。
    if (force) {
      // 显式强制：不等在跑的 run 收尾 —— kickstart 会立刻杀掉它们（消息只在内存
      // 队列里，重启后丢失）。数量写进卡片，免得用户不知道这次 force 的代价。
      interruptedCount = ctx.activeRuns.runningCount();
      log.info('command', 'release-force', { runningCount: interruptedCount });
    } else {
      // 排空阶段必须自己在卡上留痕：进度卡本来停在「typecheck ✅、test/build 全空」，
      // 用户看不出还在等在跑的 run。数量节流刷新（同一个数不重复 patch）。
      let shownCount = -1;
      const drained = await waitForRunsToDrain(ctx.activeRuns, RELEASE_DRAIN_MAX_MS, {
        onWait: async ({ runningCount, timeoutMs }) => {
          if (runningCount === shownCount) return;
          shownCount = runningCount;
          drain = { runningCount, timeoutMs };
          await push().catch((err) => log.fail('command', err, { step: 'release-card' }));
        },
      });
      if (!drained) {
        log.warn('command', 'release-drain-timeout', { maxMs: RELEASE_DRAIN_MAX_MS });
        // 只写日志用户看不见：卡上补「排空超时 + 被中断数量」，别把强杀
        // 当成正常收尾。drain 至少被 onWait 写过一次（进入等待即上报）。
        if (drain) {
          drain = { ...drain, timedOut: true };
          await push().catch((err) => log.fail('command', err, { step: 'release-card' }));
        }
      }
    }
    await close('restarting').catch((err) => log.fail('command', err, { step: 'release-card' }));
    // Carry the card's messageId so the NEW process can confirm 「已发布上线」
    // once it is actually up — the pre-boot state must not claim success.
    await markOnlineNotice(ctx.msg.chatId, 'skip', undefined, messageId, cardId, messageId ? managedSequence(messageId) : undefined);
    // 「构建成功」回复走 WS，先等它 flush 再 kickstart，否则会被 SIGTERM 丢掉。
    await new Promise((resolve) => setTimeout(resolve, RESTART_FLUSH_GRACE_MS));
    const realRestart = await ctx.controls.restartProcess();
    if (!realRestart) {
      // In-process reconnect: no boot happens, so nothing would consume
      // the marker — drop it instead of leaking a stale notification.
      await clearOnlineNotice();
      await reply(ctx, '🚀 已重新连接（当前不在 launchd 下，进程内重连）。');
    }
    log.info('command', 'release-ok', { realRestart });
  } catch (err) {
    log.fail('command', err, { step: 'release' });
    await clearOnlineNotice();
    await reply(ctx, '❌ 发布异常，bot 仍在线。');
  } finally {
    inFlight = false;
  }
}
