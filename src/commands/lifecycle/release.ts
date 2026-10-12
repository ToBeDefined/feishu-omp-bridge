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
import { releaseCard, type ReleaseStepState } from '../../card/templates';
import { sendManagedCard, updateManagedCard } from '../../card/managed';

let inFlight = false;

/** 发布/重启前等待在跑的 run 排空的上限。超时就不再等（兜底补卡逻辑仍在），
 * 但会把它写进日志与卡片，免得用户以为「什么都没发生」。 */
export const RELEASE_DRAIN_MAX_MS = 5 * 60_000;

/**
 * 等到进程内没有在跑的 run 再重启。kickstart 会连带杀掉正在执行的 OMP run：
 * 那条消息已经被 ack、队列又只在内存里，重启后就**彻底丢了**（实测一次发布
 * 吞掉一个提问），还会给它的卡片补一条「进程中断」。
 */
export async function waitForRunsToDrain(
  activeRuns: { idle(): boolean },
  timeoutMs: number = RELEASE_DRAIN_MAX_MS,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (!activeRuns.idle()) {
    if (Date.now() >= deadline) return false;
    await new Promise((r) => setTimeout(r, 500));
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
  const push = async (): Promise<void> => {
    const card = releaseCard({ steps, phase: 'running', forced: force });
    if (!messageId) {
      const sent = await sendManagedCard(ctx.channel, ctx.msg.chatId, card, ctx.msg.messageId, {
        track: true,
        kind: 'release',
      });
      messageId = sent.messageId;
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
      // 队列里，重启后丢失）。日志记下当时是否真有 run，便于事后对账。
      log.info('command', 'release-force', { busy: !ctx.activeRuns.idle() });
    } else {
      const drained = await waitForRunsToDrain(ctx.activeRuns);
      if (!drained) {
        log.warn('command', 'release-drain-timeout', { maxMs: RELEASE_DRAIN_MAX_MS });
      }
    }
    await close('restarting').catch((err) => log.fail('command', err, { step: 'release-card' }));
    // Carry the card's messageId so the NEW process can confirm 「已发布上线」
    // once it is actually up — the pre-boot state must not claim success.
    await markOnlineNotice(ctx.msg.chatId, 'skip', undefined, messageId);
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
