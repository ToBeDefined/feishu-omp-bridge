import type { CommandContext } from '../index';
import type { WorkSession } from '../../session/work-session';
import { loadSessionSummary, sampleSegmentId } from './context';
import { pickActiveSegment } from './sessions';

/**
 * 工作会话的**名字**：`/rename` 起的 title（trim 后非空），否则 undefined。
 *
 * 同步、零 IO —— 名字就在 `ws.title` 上，绝不该为了显示它去读盘 / 扫会话目录。
 * `ctx` 由调用方一并传入，让名字解析的入口在所有命令里形状一致（此函数用不到它）。
 */
export function workSessionName(_ctx: CommandContext, ws: WorkSession | undefined): string | undefined {
  const title = ws?.title?.trim();
  return title || undefined;
}

/**
 * 展示用的取样段 id —— 段选择的**唯一口径**，/search 与 /history 共用。
 *
 * - 给了 `aliveSessionIds`（调用方已扫过会话目录，知道哪些段的文件还在）时，
 *   走 `pickActiveSegment`：当前段优先，它已删则回退到最新存活段。这与 /history
 *   行展示、`继续对话`/`/resume` 实际恢复的段完全一致。
 * - 不给时只能「当前段 ?? 最新段」——不扫目录的调用方无法知道文件是否还在，这是
 *   它能诚实做出的选择（`sampleSegmentId`）。
 */
export function pickDisplaySegmentId(
  ws: WorkSession | undefined,
  aliveSessionIds?: ReadonlySet<string>,
): string | undefined {
  if (aliveSessionIds === undefined) return sampleSegmentId(ws);
  if (ws === undefined) return undefined;
  return pickActiveSegment(ws, (id) => aliveSessionIds.has(id))?.sessionId;
}

/**
 * 工作会话的展示身份，收敛 /status、/ctx、/rename、/new 各自一份的回退：
 *  - `name`：用户起的 title（有 title 时**立即返回，不做任何 IO**）；
 *  - `topic`：没有 title 时，取样段（当前段优先，否则最新段）的最后一条用户消息。
 *
 * 只试这 1 个段：取样要调 `loadSessionSummary`，那是 O(会话目录文件数) 的全目录
 * 扫描，逐段回退在大工作会话上开销线性放大（详见 `sampleSegmentId` 注释）。没有
 * 可用的段或取不到消息时，`name` 与 `topic` 都缺省。
 *
 * `aliveSessionIds`：调用方已经扫过会话目录时的存活集合，用来把取样段与 /history、
 * /resume 的段选择口径对齐（当前段文件被删时回退到存活的段）。不传则退化为
 * 不查存活的「当前段 ?? 最新段」。注意：本函数即便给了存活集合，仍会用
 * `loadSessionSummary` 去取那个段的最后消息；自带扫描结果的调用方（/search）应
 * 直接用 `pickDisplaySegmentId` + 自己的映射，不要经过这里以免重复扫目录。
 */
export async function resolveWorkSessionDisplay(
  ctx: CommandContext,
  ws: WorkSession | undefined,
  aliveSessionIds?: ReadonlySet<string>,
): Promise<{ name?: string; topic?: string }> {
  const name = workSessionName(ctx, ws);
  if (name !== undefined) return { name };
  const sampleId = pickDisplaySegmentId(ws, aliveSessionIds);
  if (sampleId === undefined) return {};
  const { lastMessage } = await loadSessionSummary(ctx, sampleId);
  const topic = lastMessage.trim();
  return topic ? { topic } : {};
}
