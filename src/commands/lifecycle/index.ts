import type { Handler } from '../index';
import { everyHandlers } from './every';
import { exitHandlers } from './exit';
import { helpHandlers } from './help';
import { psHandlers } from './ps';
import { reconnectHandlers } from './reconnect';
import { restartHandlers } from './restart';
import { stopHandlers } from './stop';

/** All lifecycle commands, merged from per-command files. */
export const lifecycleHandlers: Record<string, Handler> = {
  ...stopHandlers,
  ...restartHandlers,
  ...reconnectHandlers,
  ...psHandlers,
  ...exitHandlers,
  ...helpHandlers,
  ...everyHandlers,
};
