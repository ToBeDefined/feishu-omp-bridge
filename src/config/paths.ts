import { homedir } from 'node:os';
import { join } from 'node:path';

const appDir = join(homedir(), '.feishu-omp-bridge');

export const paths = {
  appDir,
  cacheDir: appDir,
  configFile: join(appDir, 'config.json'),
  sessionsFile: join(appDir, 'sessions.json'),
  workspacesFile: join(appDir, 'workspaces.json'),
  processesFile: join(appDir, 'processes.json'),
  secretsFile: join(appDir, 'secrets.enc'),
  keystoreSaltFile: join(appDir, '.keystore.salt'),
  secretsGetterScript: join(appDir, 'secrets-getter'),
  mediaDir: join(appDir, 'media'),
  ompSessionsDir: join(appDir, 'omp-sessions'),
  modelsCacheFile: join(appDir, 'models-cache.json'),
  modelHistoryFile: join(appDir, 'model-history.json'),
};

export const legacyPaths = {
  appDir: join(
    process.env.XDG_CONFIG_HOME ?? join(homedir(), '.config'),
    'feishu-codex-bridge',
  ),
  cacheDir: join(
    process.env.XDG_CACHE_HOME ?? join(homedir(), '.cache'),
    'feishu-codex-bridge',
  ),
};
