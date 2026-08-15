import { stat } from 'node:fs/promises';
import type { CommandContext, Handler } from '../index';
import { expandTilde, reply } from '../shared';

export const cdHandlers: Record<string, Handler> = {
  '/cd': handleCd,
};

async function handleCd(args: string, ctx: CommandContext): Promise<void> {
  const input = args.trim();
  if (!input) {
    await reply(ctx, '用法：`/cd <绝对路径>` 或 `/cd ~/xxx`');
    return;
  }
  if (!input.startsWith('/') && !input.startsWith('~')) {
    await reply(ctx, '请使用绝对路径，或 `~/xxx` 表示 home 下的子路径。');
    return;
  }
  const absolute = expandTilde(input);
  try {
    const st = await stat(absolute);
    if (!st.isDirectory()) {
      await reply(ctx, `路径不是目录：\`${absolute}\``);
      return;
    }
  } catch {
    await reply(ctx, `路径不存在：\`${absolute}\``);
    return;
  }
  ctx.activeRuns.interrupt(ctx.scope);
  ctx.workspaces.setCwd(ctx.scope, absolute);
  ctx.sessions.clear(ctx.scope);
  await reply(ctx, `✅ 已切换 cwd 到 \`${absolute}\`\n（session 已重置）`);
}
