import type { CommandContext, Handler } from '../index';
import { reply } from '../shared';
import { codeSpan } from '../../utils/text';
import type { WorkSession } from '../../session/work-session';

export const workHandlers: Record<string, Handler> = { '/work': handleWork };

const NAME_MAX = 60;

/** merge/split 都先要求本 scope 有活跃工作会话，否则无从谈起「修正」。 */
const NO_ACTIVE_WORK_SESSION = '❌ 当前没有活跃的工作会话，无法合并 / 拆分。';

/** merge/split 是首 token 命中才走的保留子命令；想用这些名字当工作名要绕开。 */
const RESERVED_HINT =
  '（`merge`/`split` 是保留子命令；想以此开头命名工作会话请先 `/rename`，或换个不以它们开头的名字）';

const notFound = (id: string): string =>
  `❌ 找不到工作会话 \`${codeSpan(id)}\`。${RESERVED_HINT}`;
const notYours = (id: string): string => `❌ \`${codeSpan(id)}\` 不是当前会话的工作会话。`;

/**
 * `/work [名字]` — 开始一件新工作。
 *
 * 这是**唯一**的工作会话边界：`/new`、`/cd`、`/ws use`、`/resume`、OMP 漂移、
 * `/release` 重启都只是同一个工作会话里的段。名字可空——为空时 `/history` 等
 * 列表里回退显示该工作会话最后一条用户消息；旧的工作会话留在历史里，不在这里
 * 啰嗦。
 *
 * 另有两个**手工修正历史分段**的子命令（首 token 命中时才走，否则整体当名字）：
 * - `/work merge <keepId> <foldId>` — 把 fold 并入 keep；
 * - `/work merge <foldId>` — 把它并入同 scope 中「更早创建的那一条」；
 * - `/work split <wsId> <段序号>` — 从第 N 段起切出一个新工作会话。
 */
export async function handleWork(args: string, ctx: CommandContext): Promise<void> {
  const input = args.trim();
  const sub = input.split(/\s+/)[0] ?? '';
  if (sub === 'merge' || sub === 'split') {
    if (!ctx.workSessions.activeWorkSession(ctx.scope)) {
      await reply(ctx, NO_ACTIVE_WORK_SESSION);
      return;
    }
    const rest = input.slice(sub.length).trim();
    if (sub === 'merge') await handleMerge(rest, ctx);
    else await handleSplit(rest, ctx);
    return;
  }

  const name = input;
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
      ? `✅ 已开始新工作会话：\`${codeSpan(name)}\`\n下一条消息在这个工作会话里继续。`
      : '✅ 已开始新工作会话（未命名，列表里显示最后一条消息）。\n下一条消息在这个工作会话里继续。',
  );
}

/**
 * `/work merge <keepId> <foldId>` / `/work merge <foldId>`。
 *
 * 双 id 形式直接给两个角色；单 id 形式按 `createdAtMs` 找同 scope 中「更早创建
 * 的那一条」当 keep（取紧邻的前一条），推断不出就报错。两个工作会话都必须属于
 * 本 scope —— 否则会把别的 chat 的历史并进来。
 */
async function handleMerge(args: string, ctx: CommandContext): Promise<void> {
  const ids = args.split(/\s+/).filter(Boolean);
  const all = ctx.workSessions.allWorkSessions();
  const find = (id: string): WorkSession | undefined => all.find((ws) => ws.id === id);

  let keepId: string;
  let foldId: string;
  if (ids.length >= 2) {
    keepId = ids[0]!;
    foldId = ids[1]!;
  } else if (ids.length === 1) {
    foldId = ids[0]!;
    const target = find(foldId);
    if (!target) {
      await reply(ctx, notFound(foldId));
      return;
    }
    if (target.scope !== ctx.scope) {
      await reply(ctx, notYours(foldId));
      return;
    }
    const earlier = all
      .filter((ws) => ws.scope === ctx.scope && ws.id !== foldId && ws.createdAtMs < target.createdAtMs)
      .sort((a, b) => b.createdAtMs - a.createdAtMs)[0];
    if (!earlier) {
      await reply(ctx, `❌ \`${codeSpan(foldId)}\` 已是最早的工作会话，没有更早的可并入。`);
      return;
    }
    keepId = earlier.id;
  } else {
    await reply(ctx, '❌ 用法：`/work merge <keepId> <foldId>` 或 `/work merge <id>`（`merge`、`split` 是保留子命令）。');
    return;
  }

  const keep = find(keepId);
  if (!keep) {
    await reply(ctx, notFound(keepId));
    return;
  }
  const fold = find(foldId);
  if (!fold) {
    await reply(ctx, notFound(foldId));
    return;
  }
  if (keep.id === fold.id) {
    await reply(ctx, '❌ 不能把工作会话并入自己。');
    return;
  }
  if (keep.scope !== ctx.scope) {
    await reply(ctx, notYours(keep.id));
    return;
  }
  if (fold.scope !== ctx.scope) {
    await reply(ctx, notYours(fold.id));
    return;
  }

  ctx.workSessions.mergeWorkSessions(keep.id, fold.id);
  // 合并会把 survivor 改键到最早段 id（keep 未必是最早创建的那条），其 id 可能
  // 已不再是 keep.id；沿仍保留的段反查回来，回复里给出真实的 survivor id。
  const anchor = keep.segments[0] ?? fold.segments[0];
  const merged =
    anchor !== undefined
      ? ctx.workSessions
          .allWorkSessions()
          .find((w) => w.segments.some((s) => s.sessionId === anchor.sessionId))
      : undefined;
  const mergedId = merged?.id ?? keep.id;
  await reply(
    ctx,
    `✅ 已把 \`${codeSpan(fold.id)}\` 并入 \`${codeSpan(mergedId)}\`` +
      (merged ? `（共 ${merged.segments.length} 段）。` : '。'),
  );
}

/**
 * `/work split <wsId> <段序号>`——段序号按该工作会话 `segments` 数组下标 1-based。
 * 首段不能当切点（切出来会是空壳），所以序号必须 ≥ 2 且不越界。
 */
async function handleSplit(args: string, ctx: CommandContext): Promise<void> {
  const [wsId, rawIndex] = args.split(/\s+/).filter(Boolean);
  if (!wsId || !rawIndex) {
    await reply(ctx, '❌ 用法：`/work split <wsId> <段序号>`（`merge`、`split` 是保留子命令）。');
    return;
  }
  const ws = ctx.workSessions.allWorkSessions().find((w) => w.id === wsId);
  if (!ws) {
    await reply(ctx, notFound(wsId));
    return;
  }
  if (ws.scope !== ctx.scope) {
    await reply(ctx, notYours(wsId));
    return;
  }
  const index = Number(rawIndex);
  if (!Number.isInteger(index) || index < 2 || index > ws.segments.length) {
    await reply(
      ctx,
      `❌ 段序号无效：需在 2 到 ${ws.segments.length} 之间（首段不能作为切点）。`,
    );
    return;
  }
  const newId = ctx.workSessions.splitWorkSession(wsId, ws.segments[index - 1]!.sessionId);
  if (newId === undefined) {
    await reply(ctx, '❌ 拆分失败。');
    return;
  }
  await reply(ctx, `✅ 已从第 ${index} 段切出新工作会话 \`${codeSpan(newId)}\`。`);
}
