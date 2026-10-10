import type { CommandContext, Handler } from '../index';
import { reply, RESTART_FLUSH_GRACE_MS } from '../shared';
import { log } from '../../core/logger';
import {
  repoRoot,
  runRelease,
  RELEASE_STEPS,
  type ReleaseResult,
  type ReleaseStepName,
} from '../../release/run';
import { clearOnlineNotify, markOnlineNotify } from '../../bot/online-notify';
import { releaseCard, type ReleaseStepState } from '../../card/templates';
import { sendManagedCard, updateManagedCard } from '../../card/managed';

let inFlight = false;

export const releaseHandlers: Record<string, Handler> = {
  '/release': handleRelease,
};

function failureNote(result: ReleaseResult): string {
  if (result.pnpmMissing) return '找不到 pnpm，请确认 PATH 里可用。';
  if (result.timedOut) return '执行超时。';
  return result.exitCode !== undefined ? `退出码 ${result.exitCode}` : '未知错误';
}

async function handleRelease(_args: string, ctx: CommandContext): Promise<void> {
  if (inFlight) {
    await reply(ctx, '⚠️ 已有一次发布正在进行，请稍候。');
    return;
  }
  inFlight = true;
  const steps = RELEASE_STEPS.map((s) => ({ name: s.name, status: 'pending' as ReleaseStepState }));
  let messageId: string | undefined;
  const push = async (): Promise<void> => {
    const card = releaseCard({ steps, phase: 'running' });
    if (!messageId) {
      const sent = await sendManagedCard(ctx.channel, ctx.msg.chatId, card, ctx.msg.messageId);
      messageId = sent.messageId;
    } else {
      await updateManagedCard(ctx.channel, messageId, card);
    }
  };
  const close = async (phase: 'success' | 'failed', failNote?: string, output?: string): Promise<void> => {
    if (!messageId) return;
    await updateManagedCard(
      ctx.channel,
      messageId,
      releaseCard({
        steps,
        phase,
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
    await close('success').catch((err) => log.fail('command', err, { step: 'release-card' }));
    // Persist which chat asked, so the post-boot "已上线" reaches it even
    // when its session entry was cleared (/new, /cd, /ws) before /release.
    await markOnlineNotify(ctx.msg.chatId);
    // 「构建成功」回复走 WS，先等它 flush 再 kickstart，否则会被 SIGTERM 丢掉。
    await new Promise((resolve) => setTimeout(resolve, RESTART_FLUSH_GRACE_MS));
    const realRestart = await ctx.controls.restartProcess();
    if (!realRestart) {
      // In-process reconnect: no boot happens, so nothing would consume
      // the marker — drop it instead of leaking a stale notification.
      await clearOnlineNotify();
      await reply(ctx, '🚀 已重新连接（当前不在 launchd 下，进程内重连）。');
    }
    log.info('command', 'release-ok', { realRestart });
  } catch (err) {
    log.fail('command', err, { step: 'release' });
    await clearOnlineNotify();
    await reply(ctx, '❌ 发布异常，bot 仍在线。');
  } finally {
    inFlight = false;
  }
}
