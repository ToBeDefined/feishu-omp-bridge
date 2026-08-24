import type { CommandContext, Handler } from '../index';
import { reply } from '../shared';
import { log } from '../../core/logger';
import { runRelease, type ReleaseResult } from '../../release/run';

let inFlight = false;

export const releaseHandlers: Record<string, Handler> = {
  '/release': handleRelease,
};

function renderFailure(result: ReleaseResult): string {
  if (result.pnpmMissing) {
    return `❌ 发布失败于 \`pnpm ${result.step}\`：找不到 \`pnpm\`，请确认 PATH 里可用。`;
  }
  if (result.timedOut) {
    return `❌ 发布失败于 \`pnpm ${result.step}\`：执行超时。`;
  }
  const exit = result.exitCode !== undefined ? `（退出码 ${result.exitCode}）` : '';
  const out = result.output ? `\n\`\`\`\n${result.output}\n\`\`\`` : '';
  return `❌ 发布失败于 \`pnpm ${result.step}\`${exit}${out}`;
}

async function handleRelease(_args: string, ctx: CommandContext): Promise<void> {
  if (inFlight) {
    await reply(ctx, '⚠️ 已有一次发布正在进行，请稍候。');
    return;
  }
  inFlight = true;
  try {
    await reply(ctx, '🔄 开始发布：`pnpm typecheck` → `pnpm test` → `pnpm build` → 重启…');
    const result = await runRelease();
    if (!result.ok) {
      await reply(ctx, renderFailure(result));
      return;
    }
    await reply(ctx, '✅ 构建成功，正在重启加载新代码…');
    const realRestart = await ctx.controls.restartProcess();
    if (!realRestart) {
      await reply(ctx, '🚀 已重新连接（当前不在 launchd 下，进程内重连）。');
    }
    log.info('command', 'release-ok', { realRestart });
  } catch (err) {
    log.fail('command', err, { step: 'release' });
    await reply(ctx, '❌ 发布异常，bot 仍在线。');
  } finally {
    inFlight = false;
  }
}
