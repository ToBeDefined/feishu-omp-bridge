import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { CommandContext, Handler } from '../index';
import { reply } from '../shared';
import { conversationCwd } from '../../session/current-cwd';
import { diffCard } from '../../card/templates';

const execFileAsync = promisify(execFile);

export const diffHandlers: Record<string, Handler> = {
  '/diff': handleDiff,
};

async function handleDiff(_args: string, ctx: CommandContext): Promise<void> {
  // 会话优先：diff 的是当前会话所在仓库。
  const cwd = conversationCwd(ctx.workspaces, ctx.workSessions, ctx.scope);
  let stat: string;
  let diff: string;
  try {
    const [statR, diffR] = await Promise.all([
      execFileAsync('git', ['diff', '--stat'], { cwd }),
      execFileAsync('git', ['diff'], { cwd }),
    ]);
    stat = statR.stdout.trim();
    diff = diffR.stdout.trim();
  } catch (err) {
    await reply(ctx, `❌ 读取 git diff 失败（cwd 可能不是 git 仓库）：${err instanceof Error ? err.message : String(err)}`);
    return;
  }
  if (!diff) {
    await reply(ctx, '✅ 工作区干净，没有未提交的改动。');
    return;
  }
  await ctx.channel.send(
    ctx.msg.chatId,
    { card: diffCard(cwd, stat, diff) },
    { replyTo: ctx.msg.messageId },
  );
}
