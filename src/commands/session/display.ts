import type { CommandContext } from '../index';
import type { WorkSession } from '../../session/work-session';
import { loadSessionSummary, sampleSegmentId } from './context';

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
 * 工作会话的展示身份，收敛 /status、/ctx、/rename、/new 各自一份的回退：
 *  - `name`：用户起的 title（有 title 时**立即返回，不做任何 IO**）；
 *  - `topic`：没有 title 时，取样段（当前段优先，否则最新段）的最后一条用户消息。
 *
 * 只试这 1 个段：取样要调 `loadSessionSummary`，那是 O(会话目录文件数) 的全目录
 * 扫描，逐段回退在大工作会话上开销线性放大（详见 `sampleSegmentId` 注释）。没有
 * 可用的段或取不到消息时，`name` 与 `topic` 都缺省。
 */
export async function resolveWorkSessionDisplay(
  ctx: CommandContext,
  ws: WorkSession | undefined,
): Promise<{ name?: string; topic?: string }> {
  const name = workSessionName(ctx, ws);
  if (name !== undefined) return { name };
  const sampleId = sampleSegmentId(ws);
  if (sampleId === undefined) return {};
  const { lastMessage } = await loadSessionSummary(ctx, sampleId);
  const topic = lastMessage.trim();
  return topic ? { topic } : {};
}
