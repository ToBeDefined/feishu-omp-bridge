import { homedir } from 'node:os';
import { stat } from 'node:fs/promises';
import { log } from '../core/logger';
import type { WorkSessionStore } from './work-store';
import type { WorkspaceStore } from '../workspace/store';

/**
 * 当前会话的目录（**只读口径**）：会话优先，没有会话时才退回聊天窗口的 cwd。
 *
 * 展示类命令（`/history` 的默认视图、`/ctx`、`/status`、`/diff`）用这个：不碰盘、
 * 不改状态，纯粹按「会话在哪跑」说出目录。
 */
export function conversationCwd(
  workspaces: WorkspaceStore,
  workSessions: WorkSessionStore,
  scope: string,
  home: string = homedir(),
): string {
  return workSessions.currentSession(scope)?.cwd ?? workspaces.cwdFor(scope) ?? home;
}

/**
 * 运行用的 cwd —— 会话优先（会话在哪跑就续在哪），并保证目录真实可用。
 *
 * 一个 OMP 会话在它自己的目录里跑、也只在那里能被 `--resume`。所以「这次跑在哪」
 * 只能由当前会话决定：
 * - scope 有当前会话且它的目录还在 → 用它，并把**聊天窗口的 cwd 同步过去**
 *   （否则 `/ctx`、`/diff`、`/cd` 的显示口径会跟实际跑的地方打架）；
 * - 没有当前会话（`/new`、`/cd`、`/ws use` 之后，或本来就没开过）→ 用聊天窗口的
 *   cwd：新对话将落在那里；
 * - 谁都不存在（目录被删/改名）→ 退回 `$HOME` 并回写，避免每次 omp spawn 都 ENOENT。
 *
 * 返回 `sessionId` 表示这一轮该 resume 哪个会话 —— 它与 cwd 来自同一处，因此调用
 * 方不需要再拿 cwd 去反查（旧代码 `resumeFor(scope, cwd)` 一旦两者不一致就静默开
 * 新对话，把上下文交给了聊天窗口）。
 */
export async function resolveConversationCwd(
  workspaces: WorkspaceStore,
  workSessions: WorkSessionStore,
  scope: string,
  home: string = homedir(),
): Promise<{ cwd: string; sessionId?: string }> {
  const current = workSessions.currentSession(scope);
  if (current !== undefined && (await isDirectory(current.cwd))) {
    if (workspaces.cwdFor(scope) !== current.cwd) {
      // 聊天窗口跟随会话：从此 cwd 的唯一真相是会话。
      workspaces.setCwd(scope, current.cwd);
    }
    return { cwd: current.cwd, sessionId: current.sessionId };
  }

  let cwd = workspaces.cwdFor(scope) ?? home;
  if (!(await isDirectory(cwd))) {
    log.warn('session', 'cwd-missing', { staleCwd: cwd });
    cwd = home;
    workspaces.setCwd(scope, cwd);
  }
  return { cwd };
}

async function isDirectory(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory();
  } catch {
    return false;
  }
}
