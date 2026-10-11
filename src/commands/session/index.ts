import type { Handler } from '../index';
import { cdHandlers } from './cd';
import { diffHandlers } from './diff';
import { historyHandlers } from './history';
import { newHandlers } from './new';
import { renameHandlers } from './rename';
import { resumeHandlers } from './resume';
import { searchHandlers } from './search';
import { statusHandlers } from './status';
import { timeoutHandlers } from './timeout';
import { wsHandlers } from './ws';

/** All session/workspace commands, merged from per-command files. */
export const sessionHandlers: Record<string, Handler> = {
  ...newHandlers,
  ...cdHandlers,
  ...diffHandlers,
  ...wsHandlers,
  ...statusHandlers,
  ...timeoutHandlers,
  ...renameHandlers,
  ...resumeHandlers,
  ...searchHandlers,
  ...historyHandlers,
  // 必须放在所有 spread **之后**（否则会被同名键覆盖）：不带参数时 `/resume`
  // （`/session`）就是 `/history` —— 两者的清单卡片原本是重复能力，现在只留
  // /history 一份；带参数（会话 id / 前缀）才走 resume 的直连恢复。转发写在这一层
  // 是因为 resume.ts 与 history.ts 互相 import 会成环，而这里本来就负责组装与路由。
  '/resume': (args, ctx) =>
    args.trim() === ''
      ? historyHandlers['/history']!(args, ctx)
      : resumeHandlers['/resume']!(args, ctx),
  '/session': (args, ctx) =>
    args.trim() === ''
      ? historyHandlers['/history']!(args, ctx)
      : resumeHandlers['/session']!(args, ctx),
};

// Re-export shared internals used by other command groups.
export { renderContext, extractUserInput } from './context';
export { summarize } from '../../utils/text';
export { searchSession } from './search';
export { renderSearchContext } from '../../card/search-card';
