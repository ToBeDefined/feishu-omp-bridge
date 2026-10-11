import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { paths } from '../src/config/paths';

/**
 * 每个 vitest worker 一份独立临时目录，把 `paths.*` 全部指过去。
 *
 * 起因（真实事故）：有的测试没有覆盖 `paths.runningCardsFile`，于是直接写到
 * `~/.feishu-omp-bridge/running-cards.json` —— 把真机文件写空/写脏，同时让同一路径在并行
 * worker 之间互相干扰（表现为「偶尔看到 2 条记录」的 flake）。setupFiles 在测试文件 import
 * 之前运行，所以模块级捕获的路径也已是临时路径。
 *
 * 个别测试仍可自行把某个 path 覆盖成更细的临时文件（更精确的隔离，不冲突）。
 */
const dir = mkdtempSync(join(tmpdir(), 'fob-test-'));
for (const key of Object.keys(paths)) {
  (paths as Record<string, string>)[key] = join(dir, key);
}
