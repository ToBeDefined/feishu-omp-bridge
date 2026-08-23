import { execFile } from 'node:child_process';
import { homedir } from 'node:os';
import { promisify } from 'node:util';
import type { CommandContext, Handler } from '../index';
import { reply } from '../shared';

const execFileAsync = promisify(execFile);
const DIFF_MAX = 4000;

export const diffHandlers: Record<string, Handler> = {
  '/diff': handleDiff,
};

/** Render a git diff into a Feishu markdown message (stat summary + body). */
export function renderDiffBody(cwd: string, stat: string, diff: string): string {
  const truncated =
    diff.length > DIFF_MAX ? `${diff.slice(0, DIFF_MAX)}\n…（diff 已截断，完整内容看本机）` : diff;
  const statBlock = stat ? `\`\`\`\n${stat}\n\`\`\`\n\n` : '';
  return `**工作区改动**（\`${cwd}\`）\n\n${statBlock}\`\`\`diff\n${truncated}\n\`\`\``;
}

async function handleDiff(_args: string, ctx: CommandContext): Promise<void> {
  const cwd = ctx.workspaces.cwdFor(ctx.scope) ?? homedir();
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
  await reply(ctx, renderDiffBody(cwd, stat, diff));
}
