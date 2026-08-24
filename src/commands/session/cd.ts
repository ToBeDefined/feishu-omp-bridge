import { stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { resolve } from 'node:path';
import type { CommandContext, Handler } from '../index';
import { expandTilde, reply } from '../shared';

export const cdHandlers: Record<string, Handler> = {
  '/cd': handleCd,
};

/** Resolve a /cd target: `~`/`~/x` expand to $HOME first, then
 *  `path.resolve` decides — absolute stays absolute, relative resolves
 *  against the scope's current cwd (falling back to $HOME). No manual
 *  absolute/relative test: resolve already implements that contract,
 *  including Windows drive-letter paths. */
export function resolveTarget(input: string, currentCwd: string | undefined): string {
  return resolve(currentCwd ?? homedir(), expandTilde(input));
}

async function handleCd(args: string, ctx: CommandContext): Promise<void> {
  const input = args.trim();
  if (!input) {
    await reply(ctx, '用法：`/cd <路径>` —— 绝对路径、`~/xxx`，或相对当前目录的路径（如 `src`、`../x`）');
    return;
  }
  const currentCwd = ctx.workspaces.cwdFor(ctx.scope);
  const absolute = resolveTarget(input, currentCwd);
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
