import type { CommandContext, Handler } from '../index';
import { reply } from '../shared';
import { codeSpan } from '../../utils/text';

export const workHandlers: Record<string, Handler> = { '/work': handleWork };

const NAME_MAX = 60;

/**
 * `/work [名字]` — 开始一件新工作。
 *
 * 这是**唯一**的工作会话边界：`/new`、`/cd`、`/ws use`、`/resume`、OMP 漂移、
 * `/release` 重启都只是同一个工作会话里的段。名字可空——为空时 `/history` 等
 * 列表里回退显示该工作会话最后一条用户消息；旧的工作会话留在历史里，不在这里
 * 啰嗦。
 */
export async function handleWork(args: string, ctx: CommandContext): Promise<void> {
  const name = args.trim();
  // 先校验：名字过长不做任何改动（不中断、不归档、不写 pendingTitle）。
  if (name.length > NAME_MAX) {
    await reply(ctx, `❌ 名字过长（上限 ${NAME_MAX} 字符）。`);
    return;
  }
  // 和 /new 一致：先把正在跑的活停掉，再开新工作会话。
  ctx.activeRuns.interrupt(ctx.scope);
  // 名字先挂到 scope 上（pendingTitle），下一摊活的第一段落地时落到它的 title。
  ctx.workSessions.startWorkSession(ctx.scope, name || undefined);
  await reply(
    ctx,
    name
      ? `✅ 已开始新工作会话：${codeSpan(name)}\n下一条消息在这个工作会话里继续。`
      : '✅ 已开始新工作会话（未命名，列表里显示最后一条消息）。\n下一条消息在这个工作会话里继续。',
  );
}
