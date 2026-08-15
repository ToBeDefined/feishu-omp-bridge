import type { Handler } from '../index';
import { accountCmdHandlers } from './account';
import { configHandlers } from './config';
import { doctorHandlers } from './doctor';

/** All account/config/doctor commands, merged from per-command files. */
export const accountHandlers: Record<string, Handler> = {
  ...accountCmdHandlers,
  ...configHandlers,
  ...doctorHandlers,
};
