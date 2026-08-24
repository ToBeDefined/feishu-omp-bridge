import type { Handler } from '../index';
import { compactHandlers } from './compact';
import { everyHandlers } from './every';
import { execHandlers } from './exec';
import { exitHandlers } from './exit';
import { helpHandlers } from './help';
import { psHandlers } from './ps';
import { reconnectHandlers } from './reconnect';
import { releaseHandlers } from './release';
import { restartHandlers } from './restart';
import { stopHandlers } from './stop';

/** All lifecycle commands, merged from per-command files. */
export const lifecycleHandlers: Record<string, Handler> = {
  ...compactHandlers,
  ...stopHandlers,
  ...restartHandlers,
  ...releaseHandlers,
  ...execHandlers,
  ...reconnectHandlers,
  ...psHandlers,
  ...exitHandlers,
  ...helpHandlers,
  ...everyHandlers,
};
