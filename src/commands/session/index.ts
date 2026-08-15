import type { Handler } from '../index';
import { cdHandlers } from './cd';
import { contextHandlers } from './context';
import { newHandlers } from './new';
import { resumeHandlers } from './resume';
import { searchHandlers } from './search';
import { statusHandlers } from './status';
import { timeoutHandlers } from './timeout';
import { wsHandlers } from './ws';

/** All session/workspace commands, merged from per-command files. */
export const sessionHandlers: Record<string, Handler> = {
  ...newHandlers,
  ...cdHandlers,
  ...wsHandlers,
  ...statusHandlers,
  ...timeoutHandlers,
  ...contextHandlers,
  ...resumeHandlers,
  ...searchHandlers,
};

// Re-export shared internals used by other command groups.
export { renderContext, extractUserInput } from './context';
export { summarize } from './shared';
