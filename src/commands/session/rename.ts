import { homedir } from 'node:os';
import { getAgentStopGraceMs, getOmpModel } from '../../config/schema';
import type { CommandContext, Handler } from '../index';
import { reply } from '../shared';
import { loadSessionSummary } from './context';
import { summarize } from './shared';

export const renameHandlers: Record<string, Handler> = {
  '/rename': handleRename,
};

const MAX_TITLE_LENGTH = 60;
const AUTO_TITLE_MAX = 20;

export async function handleRename(args: string, ctx: CommandContext): Promise<void> {
  const title = args.trim();

  if (!title) {
    const current = ctx.sessions.getRaw(ctx.scope)?.title;
    await reply(
      ctx,
      current
        ? `当前会话标题：\`${current}\`\n\n发 \`/rename <新标题>\` 修改，\`/rename auto\` 用 LLM 生成，\`/rename clear\` 清除。`
        : '当前会话没有标题。\n\n用法：`/rename <标题>` — 给当前会话起名，`/rename auto` 用 LLM 生成，`/rename clear` 清除。',
    );
    return;
  }

  if (title === 'clear') {
    const removed = ctx.sessions.clearTitle(ctx.scope);
    await reply(ctx, removed ? '✅ 已清除当前会话标题。' : '当前会话本就没有标题。');
    return;
  }

  if (title === 'auto') {
    await reply(ctx, '🤖 正在用 LLM 生成标题…');
    // 复用当前会话生成：会在当前会话历史里追加一条辅助对话（见
    // generateTitleWithLlm 副作用注释）。可能因此触发一次 run。
    const generated = await generateTitleWithLlm(ctx);
    if (!generated) {
      await reply(ctx, '❌ 无法生成标题（会话内容太少或生成失败），请手动 `/rename <标题>`。');
      return;
    }
    ctx.sessions.setTitle(ctx.scope, generated);
    await reply(ctx, `✅ 已自动生成标题：\`${generated}\``);
    return;
  }

  if (title.length > MAX_TITLE_LENGTH) {
    await reply(ctx, `❌ 标题过长（上限 ${MAX_TITLE_LENGTH} 字符）。`);
    return;
  }

  ctx.sessions.setTitle(ctx.scope, title);
  await reply(ctx, `✅ 已设置当前会话标题：\`${title}\``);
}

/** Ask the agent to summarize the session's last exchange into a short title.
 * Returns a trimmed title, or null if the session has nothing to title or
 * the model produced no usable text.
 *
 * 副作用：复用当前会话（resume sessionId）生成，因此会话历史里会追加一条
 * "根据对话生成标题…" 的辅助 user 消息 + 标题回复，占用一点上下文/token。
 * 有意为之——避免单独开新 omp 会话产生噪音 session 文件。 */
async function generateTitleWithLlm(ctx: CommandContext): Promise<string | null> {
  const sess = ctx.sessions.getRaw(ctx.scope);
  if (!sess?.sessionId) return null;

  const { lastMessage, lastReply } = await loadSessionSummary(sess.sessionId);
  const userText = summarize(lastMessage, 400);
  const replyText = lastReply ? summarize(lastReply, 400) : '';
  if (!userText && !replyText) return null;

  const prompt = [
    '根据下面的对话片段，给这个会话起一个简洁的中文标题。',
    `标题要求：不超过 ${AUTO_TITLE_MAX} 个字符，一句话概括主题。`,
    '只输出标题本身，不要引号、标点、编号或任何解释。',
    '',
    `用户：${userText}`,
    replyText ? `助手：${replyText}` : '',
  ]
    .filter(Boolean)
    .join('\n');

  const run = ctx.agent.run({
    prompt,
    sessionId: sess.sessionId,
    cwd: ctx.workspaces.cwdFor(ctx.scope) ?? homedir(),
    model: getOmpModel(ctx.controls.cfg),
    stopGraceMs: getAgentStopGraceMs(ctx.controls.cfg),
  });

  try {
    let raw = '';
    for await (const evt of run.events) {
      if (evt.type === 'text') raw += evt.delta;
      if (evt.type === 'done' || evt.type === 'error') break;
    }
    const title = trimTitle(raw);
    return title.length > 0 ? title : null;
  } finally {
    await run.stop().catch(() => {
      /* stop errors are non-fatal */
    });
  }
}

/** Normalize a model title: strip markdown/whitespace/quotes and cap length
 * by Unicode code points. */
function trimTitle(raw: string): string {
  const cleaned = raw
    .trim()
    .replace(/^["'「『【《]+|["'」』】》]+$/g, '')
    .trim();
  const chars = Array.from(cleaned);
  return chars.slice(0, AUTO_TITLE_MAX).join('');
}
