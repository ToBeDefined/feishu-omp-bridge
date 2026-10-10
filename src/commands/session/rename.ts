import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { getAgentStopGraceMs, getOmpModel, getOmpSessionDir } from '../../config/schema';
import type { CommandContext, Handler } from '../index';
import { reply } from '../shared';
import { codeSpan, summarizeMd } from '../../utils/text';
import { extractUserInput } from './context';
import { summarize } from '../../utils/text';
import { latestSegment, type WorkSession } from '../../session/work-session';

export const renameHandlers: Record<string, Handler> = {
  '/rename': handleRename,
};

const MAX_TITLE_LENGTH = 60;
const AUTO_TITLE_MAX = 30;
/** 没有任何工作会话时的统一提示：读、清、写都走它，不做任何写入。 */
const NO_WORK_SESSION = '❌ 当前还没有工作会话，先发一条消息或用 /work 开始一件新工作。';
/** Internal marker told to the model not to emit; no longer used for
 * history stripping since generation runs in an isolated session dir. */
const RENAME_AUTO_MARKER = '<rename-auto-title>';

export async function handleRename(args: string, ctx: CommandContext): Promise<void> {
  const title = args.trim();

  // /rename 命名的是**当前工作会话**（读、清、写同一目标）。没有活跃工作会话时
  // 读/清/写/auto 一律给同一条提示，且不动盘。
  const active = ctx.workSessions.activeWorkSession(ctx.scope);
  if (!active) {
    await reply(ctx, NO_WORK_SESSION);
    return;
  }

  if (!title) {
    // 名字优先；无名时回退工作会话最新段的最后一条用户消息做展示。回退消息是
    // 原始用户输入，必须与其它展示处一致地截断 + 转义，不能裸插进代码段
    //（否则长消息撑爆消息体，`*`/`` ` `` 还能把代码段提前闭合）。
    const display = active.title?.trim() || (await lastUserMessage(ctx, active));
    await reply(
      ctx,
      display
        ? `当前工作会话标题：\`${codeSpan(summarizeMd(display, 40))}\`\n\n发 \`/rename <新标题>\` 修改，\`/rename auto\` 用 LLM 生成，\`/rename clear\` 清除。`
        : '当前工作会话未命名（也没有可显示的历史消息）。\n\n用法：`/rename <标题>` — 给当前工作会话起名，`/rename auto` 用 LLM 生成，`/rename clear` 清除。',
    );
    return;
  }

  if (title === 'clear') {
    const removed = ctx.workSessions.clearTitle(ctx.scope);
    await reply(ctx, removed ? '✅ 已清除当前工作会话标题。' : '当前工作会话本就没有标题。');
    return;
  }

  if (title === 'auto') {
    // 记下目标工作会话 id：生成是异步的，期间 /work（摘掉当前指针）或 /resume
    //（切到别的工作会话）都会让 active 变样。名字必须落在发起时那个活上。
    const target = active.id;
    await reply(ctx, '🤖 正在用 LLM 生成标题…');
    const generated = await generateTitleWithLlm(ctx, active);
    if (!generated) {
      await reply(ctx, '❌ 无法生成标题（工作会话内容太少或生成失败），请手动 `/rename <标题>`。');
      return;
    }
    if (!ctx.workSessions.setTitleById(target, generated)) {
      await reply(
        ctx,
        '❌ 生成完成但目标工作会话已不存在（可能被执行了 /work 或 /resume），名字未保存。',
      );
      return;
    }
    await reply(ctx, `✅ 已自动生成工作会话标题：\`${codeSpan(generated)}\``);
    return;
  }

  if (title.length > MAX_TITLE_LENGTH) {
    await reply(ctx, `❌ 标题过长（上限 ${MAX_TITLE_LENGTH} 字符）。`);
    return;
  }

  ctx.workSessions.setTitle(ctx.scope, title);
  await reply(ctx, `✅ 已设置当前工作会话标题：\`${codeSpan(title)}\``);
}

/** 工作会话最新段的最后一条用户消息（未命名时的展示回退）。 */
async function lastUserMessage(ctx: CommandContext, ws: WorkSession): Promise<string | undefined> {
  const seg = latestSegment(ws);
  if (!seg) return undefined;
  const messages = await loadRecentUserMessages(ctx, seg.sessionId, 1);
  return messages[messages.length - 1];
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
async function generateTitleWithLlm(ctx: CommandContext, active: WorkSession): Promise<string | null> {
  // 取样窗口 = 当前工作会话**最新段**的会话文件（/new 会丢当前段指针，但段还在）。
  const seg = latestSegment(active);
  if (!seg) return null;

  const messages = await loadRecentUserMessages(ctx, seg.sessionId);
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
  ctx: CommandContext,
  sessionId: string,
  maxCount = 10,
): Promise<string[]> {
  const all: string[] = [];
  try {
    const dir = getOmpSessionDir(ctx.controls.cfg);
    const entries = await readdir(dir);
    for (const name of entries) {
      if (!name.endsWith('.jsonl')) continue;
      const text = await readFile(join(dir, name), 'utf8');
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
