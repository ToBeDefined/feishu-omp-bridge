import type { CommandContext, Handler } from '../index';
import { RESTART_FLUSH_GRACE_MS, parseForceArg, reply } from '../shared';
import { RELEASE_DRAIN_MAX_MS, waitForRunsToDrain } from './release';
import { log } from '../../core/logger';
import { clearOnlineNotice, markOnlineNotice } from '../../bot/online-notify';
import { restartCard } from '../../card/templates';
import { sendManagedCard, updateManagedCard } from '../../card/managed';

export const restartHandlers: Record<string, Handler> = {
  '/restart': handleRestart,
};

async function handleRestart(args: string, ctx: CommandContext): Promise<void> {
  const parsed = parseForceArg(args, '/restart [force]');
  if (!parsed.ok) {
    await reply(ctx, parsed.message);
    return;
  }
  const { force } = parsed;
  const runningCount = ctx.activeRuns.runningCount();
  log.info('command', 'restart', { scope: ctx.scope, force, runningCount });
  let messageId: string | undefined;
  try {
    const sent = await sendManagedCard(
      ctx.channel,
      ctx.msg.chatId,
      // 非 force 且真有 run 在跑时先说清在等谁 —— 最长 5 分钟，只写「正在重启」
      // 用户只会以为卡死。没有在跑的 run 就还是原来的「服务即将重启」。
      restartCard(!force && runningCount > 0 ? 'draining' : 'starting', undefined, {
        forced: force,
        runningCount,
        timeoutMs: RELEASE_DRAIN_MAX_MS,
      }),
      ctx.msg.messageId,
      { track: true, kind: 'restart' },
    );
    messageId = sent.messageId;
  } catch (err) {
    log.fail('command', err, { step: 'restart-card' });
    await reply(ctx, '🔄 正在重启…');
  }
  try {
    // 先等在跑的 run 收尾：kickstart 会连带杀掉它们，队列只在内存里，重启后
    // 那条消息就彻底丢了。与 /release 同一处理。
    if (force) {
      // 显式强制：立即重启，不等在跑的 run（它们会被 kickstart 杀掉）。
      log.info('command', 'restart-force', { runningCount });
    } else if (runningCount > 0) {
      // 等待可见：数量变化时刷新卡片（节流在 waitForRunsToDrain 里，≥2s 一次）。
      // 起手卡已经写着当前数量，所以从它开始比：进等待的第一次回调不重复 patch。
      let shownCount = runningCount;
      const updateWaitCard = async (count: number): Promise<void> => {
        if (!messageId || count === shownCount) return;
        shownCount = count;
        await updateManagedCard(
          ctx.channel,
          messageId,
          restartCard('draining', undefined, { runningCount: count, timeoutMs: RELEASE_DRAIN_MAX_MS }),
        ).catch((err) => log.fail('command', err, { step: 'restart-card' }));
      };
      const drained = await waitForRunsToDrain(ctx.activeRuns, RELEASE_DRAIN_MAX_MS, {
        onWait: ({ runningCount: current }) => updateWaitCard(current),
      });
      if (!drained) {
        log.warn('command', 'restart-drain-timeout', { maxMs: RELEASE_DRAIN_MAX_MS });
        // 只写日志用户看不见：卡上写明超时强杀、几个在跑任务被中断，
        // 别让「重启完成」把这次强杀盖过去。
        if (messageId) {
          await updateManagedCard(
            ctx.channel,
            messageId,
            restartCard('draining', undefined, {
              runningCount: ctx.activeRuns.runningCount(),
              timeoutMs: RELEASE_DRAIN_MAX_MS,
              timedOut: true,
            }),
          ).catch((err) => log.fail('command', err, { step: 'restart-card' }));
        }
      } else if (messageId) {
        // 排空结束、真要重启了：切回「服务即将重启」，别让等待态留在屏幕上。
        await updateManagedCard(ctx.channel, messageId, restartCard('starting')).catch((err) =>
          log.fail('command', err, { step: 'restart-card' }),
        );
      }
    }
    // The new process sends the boot confirmation for a real launchd restart.
    await markOnlineNotice(ctx.msg.chatId, 'notify', undefined, messageId);
    await new Promise((resolve) => setTimeout(resolve, RESTART_FLUSH_GRACE_MS));
    const realRestart = await ctx.controls.restartProcess();
    if (!realRestart) {
      await clearOnlineNotice();
      if (messageId) {
        await updateManagedCard(ctx.channel, messageId, restartCard('done')).catch(() => {});
      } else {
        await reply(ctx, '🚀 重启完成，已重新连接。');
      }
    }
    log.info('command', 'restart-ok', { realRestart });
  } catch (err) {
    log.fail('command', err, { step: 'restart' });
    await clearOnlineNotice();
    if (messageId) {
      await updateManagedCard(
        ctx.channel,
        messageId,
        restartCard('failed', err instanceof Error ? err.message : String(err)),
      ).catch(() => {});
    } else {
      await reply(ctx, '❌ 重启失败，bot 仍在线。');
    }
  }
}
