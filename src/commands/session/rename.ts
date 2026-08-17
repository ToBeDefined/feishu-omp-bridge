import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { paths } from '../../config/paths';
import { getAgentStopGraceMs, getOmpModel } from '../../config/schema';
import type { CommandContext, Handler } from '../index';
import { reply } from '../shared';
import { extractUserInput } from './context';
import { summarize } from '../shared';

export const renameHandlers: Record<string, Handler> = {
  '/rename': handleRename,
};

const MAX_TITLE_LENGTH = 60;
const AUTO_TITLE_MAX = 30;
/** Internal marker told to the model not to emit; no longer used for
 * history stripping since generation runs in an isolated session dir. */
const RENAME_AUTO_MARKER = '<rename-auto-title>';

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

/** Ask the agent to title the session from the user's recent messages. A
 * title reflects what the user was working on, so only their messages are
 * sent — assistant replies add noise and tokens. Returns a trimmed title, or
 * null if there's nothing to title or the model produced no usable text.
 *
 * Generates in an isolated throwaway session dir, so the model sees only the
 * user-message list below — never the main session history, which is noisy
 * and can carry echoed generation prompts that skew the title. Isolation also
 * means the generation prompt never lands in the main session file or gets
 * echoed back by the bridge. */
async function generateTitleWithLlm(ctx: CommandContext): Promise<string | null> {
  const sess = ctx.sessions.getRaw(ctx.scope);
  if (!sess?.sessionId) return null;

  const messages = await loadRecentUserMessages(sess.sessionId);
  if (messages.length === 0) return null;
  const list = messages.map((m, i) => `${i + 1}. ${summarize(m, 200)}`).join('\n');

  const prompt = [
    '根据这个会话中用户提出的问题和需求，给会话起一个简洁的中文标题。',
    `标题要求：不超过 ${AUTO_TITLE_MAX} 个字符，一句话概括对话主题。`,
    '只输出标题本身，不要引号、标点、编号或任何解释。',
    `（内部标记 ${RENAME_AUTO_MARKER}，请勿输出）`,
    '',
    '用户消息：',
    list,
  ]
    .filter(Boolean)
    .join('\n');

  // Generate in a throwaway session dir so the model sees ONLY the
  // user-message list below — never the full (noisy, possibly echo-polluted)
  // main session history, which skews the title. Isolation also keeps the
  // generation prompt out of the main session file / bridge echo.
  const sessionDir = await mkdtemp(join(tmpdir(), 'rename-auto-'));

  const run = ctx.agent.run({
    prompt,
    sessionDir,
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
    // Drop the throwaway session dir; nothing to clean from the main history.
    await rm(sessionDir, { recursive: true, force: true }).catch(() => {
      /* best-effort cleanup */
    });
  }
}

/** Collect the most recent real user messages for a session (newest last),
 * skipping bridge-wrapper / system-prompt frames. Capped at `maxCount`. */
async function loadRecentUserMessages(
  sessionId: string,
  maxCount = 10,
): Promise<string[]> {
  const all: string[] = [];
  try {
    const entries = await readdir(paths.ompSessionsDir);
    for (const name of entries) {
      if (!name.endsWith('.jsonl')) continue;
      const text = await readFile(join(paths.ompSessionsDir, name), 'utf8');
      if (!text.includes(`"id":"${sessionId}"`)) continue;
      for (const line of text.split('\n')) {
        if (!line.includes('"type":"message"')) continue;
        try {
          const frame = JSON.parse(line) as {
            message?: { role?: string; content?: Array<{ type?: string; text?: string }> };
          };
          const m = frame.message;
          if (m?.role !== 'user') continue;
          const textPart = (m.content ?? [])
            .filter((c) => c.type === 'text' && c.text)
            .map((c) => c.text ?? '')
            .join('');
          const real = extractUserInput(textPart);
          if (real) all.push(real);
        } catch {
          /* skip malformed */
        }
      }
      break;
    }
  } catch {
    /* fall through to empty */
  }
  return all.slice(-maxCount);
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
