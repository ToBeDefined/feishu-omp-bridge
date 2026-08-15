import type { Handler } from '../index';
import { modelHandlers as modelCmdHandlers } from './model';
import { thinkingHandlers } from './thinking';

/** All model-related commands, merged from per-command files. */
export const modelHandlers: Record<string, Handler> = {
  ...modelCmdHandlers,
  ...thinkingHandlers,
};

export { loadModelData, commonOmpModels, listOmpModels, type OmpModelEntry, type ModelsCache } from './data';
