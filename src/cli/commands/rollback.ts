import { execFile, type ExecFileOptionsWithStringEncoding } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { paths } from '../../config/paths';
import { clearBootFailures } from '../../daemon/boot-guard';
import { repoRoot, runRelease, type ReleaseExec, type ReleaseResult } from '../../release/run';
import { runServiceRestart } from './service';

/** git 命令统一超时（revert/commit 都是大操作，30s 足够）。 */
const GIT_TIMEOUT_MS = 30_000;
const MAX_BUFFER = 8 * 1024 * 1024;
const SHA_DISPLAY = 12;

export function shortSha(sha: string): string {
  return sha.slice(0, SHA_DISPLAY);
}

// === 目标解析（纯决策，git 查询通过 deps 注入，便于单测） ===

export type RollbackTargetSource = 'arg' | 'lastGoodSha' | 'head~1';

export interface RollbackTargetInput {
  /** CLI 显式传入的 `<sha|ref>`。 */
  arg?: string;
  /** heal-state.json 的 `lastGoodSha`（读不到时为 undefined）。 */
  lastGoodSha?: string;
  /** 当前 HEAD 的完整 sha。 */
  head: string;
}

/** 解析目标所需的 git 能力 —— 注入以便纯函数式单测。 */
export interface RollbackTargetDeps {
  /** 把 ref/sha 解析成完整 commit sha；解析不了返回 undefined。 */
  resolveCommit: (ref: string) => Promise<string | undefined>;
  /** `ancestor` 是否为 `descendant` 的祖先。 */
  isAncestor: (ancestor: string, descendant: string) => Promise<boolean>;
}

export type RollbackTargetResolution =
  | { ok: true; target: string; source: RollbackTargetSource }
  | { ok: false; reason: 'already-at-target' | 'invalid-target' | 'no-target'; message: string };

const SOURCE_LABEL: Record<RollbackTargetSource, string> = {
  arg: '指定参数',
  lastGoodSha: 'heal-state.json 的 lastGoodSha',
  'head~1': 'HEAD~1',
};

/**
 * 决定回退到哪个提交：
 * - 显式参数：必须能在本仓库解析成 commit、是 HEAD 的祖先且不等于 HEAD。
 * - 无参数：优先 lastGoodSha（解析不了 / 等于 HEAD / 不是祖先则忽略），
 *   否则 HEAD~1。
 */
export async function resolveRollbackTarget(
  input: RollbackTargetInput,
  deps: RollbackTargetDeps,
): Promise<RollbackTargetResolution> {
  const head = input.head.trim();
  const arg = input.arg?.trim();

  if (arg) {
    const sha = await deps.resolveCommit(arg);
    if (!sha) {
      return {
        ok: false,
        reason: 'invalid-target',
        message: `❌ 无法解析回退目标 “${arg}”：不是本仓库中的有效提交。`,
      };
    }
    if (sha === head) {
      return {
        ok: false,
        reason: 'already-at-target',
        message: `已经在目标提交 ${shortSha(sha)} 上，无需回退。`,
      };
    }
    if (!(await deps.isAncestor(sha, head))) {
      return {
        ok: false,
        reason: 'invalid-target',
        message: `❌ 目标 ${shortSha(sha)} 不是 HEAD(${shortSha(head)}) 的祖先，无法用 revert 回退（历史可能已被重写）。`,
      };
    }
    return { ok: true, target: sha, source: 'arg' };
  }

  const lastGood = input.lastGoodSha?.trim();
  if (lastGood) {
    const sha = await deps.resolveCommit(lastGood);
    if (sha && sha !== head && (await deps.isAncestor(sha, head))) {
      return { ok: true, target: sha, source: 'lastGoodSha' };
    }
  }

  const prev = await deps.resolveCommit('HEAD~1');
  if (!prev) {
    return {
      ok: false,
      reason: 'no-target',
      message: '❌ 没有可回退的历史提交（HEAD 已是最早提交），请显式指定目标。',
    };
  }
  if (prev === head) {
    return {
      ok: false,
      reason: 'already-at-target',
      message: `已经在最早提交 ${shortSha(head)} 上，无需回退。`,
    };
  }
  return { ok: true, target: prev, source: 'head~1' };
}

// === 子进程 / git 工具 ===

interface ExecFailure extends Error {
  code?: number | string;
  stdout?: string;
  stderr?: string;
}

/** execFile wrapped so captured stdout/stderr are surfaced on rejection.
 *  与 release 的 runner 结构一致，因此同一个注入桩可同时驱动 git 与 pnpm。
 *  这里必须用 executor 形式：execFile 是回调 API，而 `Promise.withResolvers`
 *  需要 Node 22+，本包 engines 仍是 node >=20。 */
export const rollbackExec: ReleaseExec = (command, args, options) =>
  new Promise((resolveExec, rejectExec) => {
    const execOptions = {
      ...options,
      maxBuffer: MAX_BUFFER,
      encoding: 'utf8',
    } as ExecFileOptionsWithStringEncoding;
    execFile(command, args, execOptions, (error, stdout, stderr) => {
      if (error) {
        const e = error as ExecFailure;
        e.stdout = stdout;
        e.stderr = stderr;
        rejectExec(e);
        return;
      }
      resolveExec({ stdout, stderr });
    });
  });

/** 失败的输出（优先 stderr），用于人类可读的报错。 */
function failureText(err: unknown): string {
  const e = err as ExecFailure | undefined;
  const raw = (e?.stderr || e?.stdout || '').trim();
  if (raw) return raw;
  return err instanceof Error ? err.message : String(err);
}

async function git(
  exec: ReleaseExec,
  cwd: string,
  args: string[],
  timeout: number = GIT_TIMEOUT_MS,
): Promise<{ stdout: string; stderr: string }> {
  return exec('git', args, { timeout, cwd });
}

/** 只关心成败的 git 调用（exit code 即语义，如 --is-ancestor / --quiet）。 */
async function gitOk(exec: ReleaseExec, cwd: string, args: string[]): Promise<boolean> {
  try {
    await git(exec, cwd, args);
    return true;
  } catch {
    return false;
  }
}

async function resolveCommit(exec: ReleaseExec, cwd: string, ref: string): Promise<string | undefined> {
  try {
    const { stdout } = await git(exec, cwd, ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`]);
    return stdout.trim() || undefined;
  } catch {
    return undefined;
  }
}

async function isAncestor(exec: ReleaseExec, cwd: string, ancestor: string, descendant: string): Promise<boolean> {
  return gitOk(exec, cwd, ['merge-base', '--is-ancestor', ancestor, descendant]);
}

/**
 * 把仓库恢复到 `preHead`：先 `git revert --abort` 清掉冲突/sequencer 状态，
 * 再 `git reset --hard preHead` 兜底。本命令开始前已确认工作区干净，且
 * reset 只会撤销本次自动创建的 revert，不会动用户未提交的改动。
 */
async function restoreHead(exec: ReleaseExec, cwd: string, preHead: string): Promise<boolean> {
  await gitOk(exec, cwd, ['revert', '--abort']);
  return gitOk(exec, cwd, ['reset', '--hard', preHead]);
}

function renderReleaseFailure(result: ReleaseResult): string {
  if (result.pnpmMissing) return `pnpm ${result.step} 找不到 pnpm（ENOENT）`;
  if (result.timedOut) return `pnpm ${result.step} 执行超时`;
  const exit = result.exitCode !== undefined ? `（退出码 ${result.exitCode}）` : '';
  const out = result.output ? `\n${result.output}` : '';
  return `pnpm ${result.step}${exit}${out}`;
}

// === heal-state.json ===

export const HEAL_STATE_FILE = join(paths.appDir, 'heal-state.json');

/** 读 self-heal 记录的最近健康提交；文件缺失/损坏/字段类型不对都当没有。 */
export async function readLastGoodSha(file: string = HEAL_STATE_FILE): Promise<string | undefined> {
  try {
    const parsed = JSON.parse(await readFile(file, 'utf8')) as { lastGoodSha?: unknown } | null;
    const sha = typeof parsed?.lastGoodSha === 'string' ? parsed.lastGoodSha.trim() : '';
    return sha || undefined;
  } catch {
    return undefined;
  }
}

// === 编排 ===

export interface RollbackDeps {
  exec: ReleaseExec;
  cwd: string;
  readLastGoodSha: () => Promise<string | undefined>;
  /** 最后一步 —— 必须先清 boot 熔断再重启，否则新 boot 会被挡下。 */
  restart: () => Promise<void>;
  log: (line: string) => void;
}

export type RollbackOutcome =
  | { status: 'noop'; message: string }
  | { status: 'rolled-back'; target: string; revertSha: string; message: string }
  | { status: 'error'; message: string };

/**
 * 回退到目标提交（`git revert --no-commit <target>..HEAD` + 一条 revert 提交，
 * 绝不改历史）→ 跑发布流水线 → 重启 daemon。
 */
export async function runRollback(opts: { arg?: string; deps: RollbackDeps }): Promise<RollbackOutcome> {
  const { exec, cwd, readLastGoodSha: readSha, restart, log } = opts.deps;

  let head: string;
  try {
    head = (await git(exec, cwd, ['rev-parse', 'HEAD'])).stdout.trim();
  } catch (err) {
    return { status: 'error', message: `❌ 无法读取 git HEAD：${failureText(err)}` };
  }

  let dirty: string;
  try {
    dirty = (await git(exec, cwd, ['status', '--porcelain'])).stdout.trim();
  } catch (err) {
    return { status: 'error', message: `❌ 无法读取工作区状态：${failureText(err)}` };
  }
  if (dirty) {
    return {
      status: 'error',
      message: `❌ 工作区有未提交改动，已拒绝回退（避免覆盖你的改动；请先 commit 或 stash）：\n${dirty}`,
    };
  }

  const lastGoodSha = await readSha();
  const resolution = await resolveRollbackTarget(
    { arg: opts.arg, lastGoodSha, head },
    {
      resolveCommit: (ref) => resolveCommit(exec, cwd, ref),
      isAncestor: (a, b) => isAncestor(exec, cwd, a, b),
    },
  );
  if (!resolution.ok) {
    return resolution.reason === 'already-at-target'
      ? { status: 'noop', message: resolution.message }
      : { status: 'error', message: resolution.message };
  }

  const target = resolution.target;
  log(`回退：目标 ${shortSha(target)}（${SOURCE_LABEL[resolution.source]}），当前 HEAD ${shortSha(head)}`);

  try {
    await git(exec, cwd, ['revert', '--no-commit', `${target}..HEAD`]);
  } catch (err) {
    const restored = await restoreHead(exec, cwd, head);
    const tail = restored
      ? `已 git revert --abort 并恢复到操作前的 HEAD ${shortSha(head)}，未留下半成品。`
      : `⚠ 自动恢复失败，请手动检查 git status。`;
    return {
      status: 'error',
      message: `❌ git revert ${shortSha(target)}..HEAD 失败（冲突或无法直接 revert 的提交），${tail}\n${failureText(err)}`,
    };
  }

  // revert --no-commit 应已把改动放进 index。range 内只有空提交时可能无变更，
  // 这时 git commit 必然失败 —— 提前识别，避免留下 index 里的半成品。
  if (await gitOk(exec, cwd, ['diff', '--cached', '--quiet'])) {
    await restoreHead(exec, cwd, head);
    return {
      status: 'error',
      message: `❌ revert 未产生任何变更（${shortSha(target)} 与 HEAD 的内容一致），无需回退。`,
    };
  }

  let revertSha: string;
  try {
    await git(exec, cwd, ['commit', '-m', `revert: 回退到 ${shortSha(target)}（rollback）`]);
    revertSha = (await git(exec, cwd, ['rev-parse', 'HEAD'])).stdout.trim();
  } catch (err) {
    const restored = await restoreHead(exec, cwd, head);
    const tail = restored
      ? `已恢复到操作前的 HEAD ${shortSha(head)}。`
      : `⚠ 自动恢复失败，请手动检查 git status。`;
    return {
      status: 'error',
      message: `❌ 创建 revert 提交失败，${tail}\n${failureText(err)}`,
    };
  }
  log(`✓ 已创建 revert 提交 ${shortSha(revertSha)}`);

  log('流水线：pnpm typecheck → pnpm test → pnpm build…');
  const release = await runRelease(exec, cwd);
  if (!release.ok) {
    const restored = await gitOk(exec, cwd, ['reset', '--hard', head]);
    const tail = restored
      ? `已 git reset --hard 恢复到操作前的 HEAD ${shortSha(head)}（撤销本次自动创建的 revert 提交 ${shortSha(revertSha)}）。`
      : `⚠ 恢复到 ${shortSha(head)} 失败，请手动执行 git reset --hard ${head}。`;
    return {
      status: 'error',
      message: `❌ 流水线失败：${renderReleaseFailure(release)}\n${tail}`,
    };
  }

  try {
    await restart();
  } catch (err) {
    return {
      status: 'error',
      message: `❌ 构建通过，但重启 daemon 失败：${failureText(err)}\n回退提交 ${shortSha(revertSha)} 已保留，可手动 feishu-omp-bridge restart 重试。`,
    };
  }

  return {
    status: 'rolled-back',
    target,
    revertSha,
    message: `✓ 已回退到 ${shortSha(target)}（revert 提交 ${shortSha(revertSha)}），流水线通过，daemon 已重启。`,
  };
}

/** 生产环境的依赖：真实 git/pnpm + heal-state + 清熔断后重启。 */
export function defaultRollbackDeps(overrides: Partial<RollbackDeps> = {}): RollbackDeps {
  return {
    exec: rollbackExec,
    cwd: repoRoot(),
    readLastGoodSha: () => readLastGoodSha(),
    restart: async () => {
      await clearBootFailures();
      await runServiceRestart();
    },
    log: (line) => console.log(line),
    ...overrides,
  };
}

export async function runRollbackCli(
  target?: string,
  deps: RollbackDeps = defaultRollbackDeps(),
): Promise<void> {
  console.log('回退：解析目标 → git revert → 发布流水线 → restart…');
  const outcome = await runRollback({ arg: target, deps });
  if (outcome.status === 'error') {
    console.error(outcome.message);
    process.exit(1);
  }
  console.log(outcome.message);
}
