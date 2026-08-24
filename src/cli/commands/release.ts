import { runRelease, type ReleaseResult } from '../../release/run';
import { runServiceRestart } from './service';

function renderCliFailure(result: ReleaseResult): string {
  if (result.pnpmMissing) {
    return `❌ 发布失败于 pnpm ${result.step}：找不到 pnpm（ENOENT）。`;
  }
  if (result.timedOut) {
    return `❌ 发布失败于 pnpm ${result.step}：执行超时。`;
  }
  const exit = result.exitCode !== undefined ? `（退出码 ${result.exitCode}）` : '';
  const out = result.output ? `\n${result.output}` : '';
  return `❌ 发布失败于 pnpm ${result.step}${exit}${out}`;
}

export async function runReleaseCli(): Promise<void> {
  console.log('发布：pnpm typecheck → pnpm test → pnpm build → restart…');
  const result = await runRelease(undefined, process.cwd());
  if (!result.ok) {
    console.error(renderCliFailure(result));
    process.exit(1);
  }
  console.log('✓ 构建成功，正在重启 daemon…');
  await runServiceRestart();
}
