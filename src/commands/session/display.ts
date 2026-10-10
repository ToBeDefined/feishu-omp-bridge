import type { CommandContext } from '../index';
import type { WorkSession } from '../../session/work-session';
import { loadSessionSummary } from './context';

/**
 * 会话的**名字**：`/rename` 起的 title（trim 后非空），否则 undefined。
 *
 * 同步、零 IO —— 名字就在 `ws.title` 上，绝不该为了显示它去读盘 / 扫会话目录。
 */
export function sessionName(ws: WorkSession | undefined): string | undefined {
  const title = ws?.title?.trim();
  return title || undefined;
}

/**
 * 会话的 OMP 会话 id（一个 OMP 会话 = 一个对话）。取当前段，退化到首段 id。
 */
export function sessionIdOf(ws: WorkSession | undefined): string | undefined {
  return ws?.currentSegmentId ?? ws?.id;
}

/**
 * 会话的展示身份，收敛 /status、/ctx、/rename 各自一份的回退：
 *  - `name`：用户起的 title（有 title 时**立即返回，不做任何 IO**）；
 *  - `topic`：没有 title 时，该会话最后一条用户消息。
 *
 * 取消息要调 `loadSessionSummary`，那是 O(会话目录文件数) 的全目录扫描（会话文件
 * 可能数 MB），所以有无名会话时才付这个代价。没有会话 / 取不到消息时两者都缺省。
 */
export async function resolveSessionDisplay(
  ctx: CommandContext,
  ws: WorkSession | undefined,
): Promise<{ name?: string; topic?: string }> {
  const name = sessionName(ws);
  if (name !== undefined) return { name };
  const sessionId = ws?.currentSegmentId ?? ws?.id;
  if (sessionId === undefined) return {};
  const { lastMessage } = await loadSessionSummary(ctx, sessionId);
  const topic = lastMessage.trim();
  return topic ? { topic } : {};
}
