import type { WorkSession } from '../../session/work-session';

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
