import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi, type Mock } from 'vitest';
import type { ReleaseExec } from '../../release/run';
import {
  readLastGoodSha,
  resolveRollbackTarget,
  rollbackExec,
  runRollback,
  runRollbackCli,
  shortSha,
  type RollbackDeps,
  type RollbackTargetDeps,
} from './rollback';

// === 临时仓库工具（真实 git） ===

const temps: string[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(temps.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function tempDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  temps.push(dir);
  return dir;
}

/** 真实 git 调用 —— 复用被测模块自己的 runner，避免引入第二套 exec 包装。 */
async function git(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await rollbackExec('git', args, { cwd, timeout: 30_000 });
  return stdout.trim();
}

async function initRepo(): Promise<string> {
  const dir = await tempDir('rollback-test-');
  await git(dir, ['init', '-q', '-b', 'main']);
  await git(dir, ['config', 'user.email', 'rollback@test.local']);
  await git(dir, ['config', 'user.name', 'rollback test']);
  return dir;
}

async function commitFile(dir: string, name: string, content: string, message: string): Promise<string> {
  await writeFile(join(dir, name), content);
  await git(dir, ['add', name]);
  await git(dir, ['commit', '-q', '-m', message]);
  return git(dir, ['rev-parse', 'HEAD']);
}

interface Harness {
  deps: RollbackDeps;
  logs: string[];
  restart: Mock;
  pnpmCalls: string[][];
}

/** git 走真实临时仓库；pnpm 被拦下来记调用（可按需失败）。 */
function harness(dir: string, opts: { lastGoodSha?: string; release?: 'ok' | 'fail' } = {}): Harness {
  const pnpmCalls: string[][] = [];
  const exec: ReleaseExec = async (command, args, options) => {
    if (command === 'git') return rollbackExec(command, args, options);
    if (command !== 'pnpm') throw new Error(`unexpected command: ${command}`);
    pnpmCalls.push(args);
    if (opts.release === 'fail') {
      throw Object.assign(new Error('pnpm boom'), { code: 1, stderr: 'typecheck 报错\n' });
    }
    return { stdout: '', stderr: '' };
  };
  const logs: string[] = [];
  const restart = vi.fn(async () => {});
  const deps: RollbackDeps = {
    exec,
    cwd: dir,
    readLastGoodSha: async () => opts.lastGoodSha,
    restart,
    log: (line) => {
      logs.push(line);
    },
  };
  return { deps, logs, restart, pnpmCalls };
}

// === 目标解析（纯决策） ===

const HEAD = 'a'.repeat(40);
const PARENT = 'b'.repeat(40);
const OLD = 'c'.repeat(40);

function targetDeps(
  commits: Record<string, string | undefined>,
  ancestors: Array<[string, string]> = [],
): RollbackTargetDeps {
  return {
    resolveCommit: async (ref) => commits[ref],
    isAncestor: async (a, b) => ancestors.some(([x, y]) => x === a && y === b),
  };
}

describe('resolveRollbackTarget', () => {
  it('显式参数：是 HEAD 祖先且不等于 HEAD → 采用', async () => {
    const r = await resolveRollbackTarget({ arg: 'v1.2.3', head: HEAD }, targetDeps({ 'v1.2.3': OLD }, [[OLD, HEAD]]));
    expect(r).toEqual({ ok: true, target: OLD, source: 'arg' });
  });

  it('显式参数：等于 HEAD → already-at-target', async () => {
    const r = await resolveRollbackTarget({ arg: HEAD, head: HEAD }, targetDeps({ [HEAD]: HEAD }));
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error('unreachable');
    expect(r.reason).toBe('already-at-target');
    expect(r.message).toContain('无需回退');
  });

  it('显式参数：解析不了 → invalid-target', async () => {
    const r = await resolveRollbackTarget({ arg: 'nope', head: HEAD }, targetDeps({}, [[OLD, HEAD]]));
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error('unreachable');
    expect(r.reason).toBe('invalid-target');
    expect(r.message).toContain('无法解析回退目标');
  });

  it('显式参数：不是 HEAD 的祖先 → invalid-target', async () => {
    const r = await resolveRollbackTarget({ arg: 'other', head: HEAD }, targetDeps({ other: OLD }, []));
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error('unreachable');
    expect(r.reason).toBe('invalid-target');
    expect(r.message).toContain('不是 HEAD');
  });

  it('无参数：优先采用可解析的 lastGoodSha', async () => {
    const r = await resolveRollbackTarget(
      { lastGoodSha: 'good', head: HEAD },
      targetDeps({ good: OLD, 'HEAD~1': PARENT }, [[OLD, HEAD]]),
    );
    expect(r).toEqual({ ok: true, target: OLD, source: 'lastGoodSha' });
  });

  it('无参数：lastGoodSha 解析不了 → 退回 HEAD~1', async () => {
    const r = await resolveRollbackTarget(
      { lastGoodSha: 'ghost', head: HEAD },
      targetDeps({ 'HEAD~1': PARENT }, [[PARENT, HEAD]]),
    );
    expect(r).toEqual({ ok: true, target: PARENT, source: 'head~1' });
  });

  it('无参数：lastGoodSha 等于 HEAD → 退回 HEAD~1（避免空回退）', async () => {
    const r = await resolveRollbackTarget(
      { lastGoodSha: HEAD, head: HEAD },
      targetDeps({ [HEAD]: HEAD, 'HEAD~1': PARENT }, [[PARENT, HEAD]]),
    );
    expect(r).toEqual({ ok: true, target: PARENT, source: 'head~1' });
  });

  it('无参数：lastGoodSha 不在 HEAD 祖先链上（历史被重写）→ 退回 HEAD~1', async () => {
    const r = await resolveRollbackTarget(
      { lastGoodSha: 'orphan', head: HEAD },
      targetDeps({ orphan: OLD, 'HEAD~1': PARENT }, [[PARENT, HEAD]]),
    );
    expect(r).toEqual({ ok: true, target: PARENT, source: 'head~1' });
  });

  it('无参数：没有 lastGoodSha → HEAD~1', async () => {
    const r = await resolveRollbackTarget({ head: HEAD }, targetDeps({ 'HEAD~1': PARENT }, [[PARENT, HEAD]]));
    expect(r).toEqual({ ok: true, target: PARENT, source: 'head~1' });
  });

  it('无参数：HEAD 是最早提交（无 HEAD~1）→ no-target', async () => {
    const r = await resolveRollbackTarget({ head: HEAD }, targetDeps({}));
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error('unreachable');
    expect(r.reason).toBe('no-target');
    expect(r.message).toContain('最早提交');
  });
});

describe('readLastGoodSha', () => {
  it('读取并 trim 有效字段', async () => {
    const dir = await tempDir('rollback-state-');
    const file = join(dir, 'heal-state.json');
    await writeFile(file, JSON.stringify({ lastGoodSha: '  abc123def456  ' }));
    expect(await readLastGoodSha(file)).toBe('abc123def456');
  });

  it('文件缺失 / 内容损坏 / 字段类型不对 / 空串 都返回 undefined', async () => {
    const dir = await tempDir('rollback-state-');
    expect(await readLastGoodSha(join(dir, 'missing.json'))).toBeUndefined();

    const corrupt = join(dir, 'corrupt.json');
    await writeFile(corrupt, '{not json');
    expect(await readLastGoodSha(corrupt)).toBeUndefined();

    const wrongType = join(dir, 'wrong.json');
    await writeFile(wrongType, JSON.stringify({ lastGoodSha: 42 }));
    expect(await readLastGoodSha(wrongType)).toBeUndefined();

    const nullish = join(dir, 'null.json');
    await writeFile(nullish, 'null');
    expect(await readLastGoodSha(nullish)).toBeUndefined();

    const empty = join(dir, 'empty.json');
    await writeFile(empty, JSON.stringify({ lastGoodSha: '   ' }));
    expect(await readLastGoodSha(empty)).toBeUndefined();
  });
});

// === 真实临时仓库：编排 + git revert ===

describe('runRollback（真实临时仓库）', () => {
  it('回退到祖先：产生 revert 提交、跑完流水线、重启 daemon', async () => {
    const dir = await initRepo();
    const c1 = await commitFile(dir, 'f', 'a\n', 'c1');
    const c2 = await commitFile(dir, 'g', 'b\n', 'c2');
    const c3 = await commitFile(dir, 'g', 'c\n', 'c3');
    const h = harness(dir);

    const outcome = await runRollback({ arg: c1, deps: h.deps });

    expect(outcome.status).toBe('rolled-back');
    if (outcome.status !== 'rolled-back') throw new Error('unreachable');
    expect(outcome.target).toBe(c1);
    expect(outcome.revertSha).not.toBe(c3);
    expect(outcome.message).toContain(shortSha(c1));

    // 历史只增不减：3 个原始提交 + 1 个 revert 提交。
    expect(await git(dir, ['rev-list', '--count', 'HEAD'])).toBe('4');
    expect(await git(dir, ['log', '-1', '--pretty=%s'])).toBe(`revert: 回退到 ${shortSha(c1)}（rollback）`);

    // 工作树回到 c1 的内容（g 已被 revert 掉）。
    expect(existsSync(join(dir, 'g'))).toBe(false);
    expect(await readFile(join(dir, 'f'), 'utf8')).toBe('a\n');
    expect(await git(dir, ['status', '--porcelain'])).toBe('');

    expect(h.pnpmCalls).toEqual([['typecheck'], ['test'], ['build']]);
    expect(h.restart).toHaveBeenCalledTimes(1);
    expect(h.logs.some((line) => line.includes('已创建 revert 提交'))).toBe(true);
    // revert 提交直接挂在原 HEAD(c3) 之上 —— 历史只增不减。
    expect(await git(dir, ['rev-parse', 'HEAD~1'])).toBe(c3);
    expect(await git(dir, ['rev-parse', 'HEAD~2'])).toBe(c2);
  });

  it('无参数：heal-state.json 的 lastGoodSha 生效', async () => {
    const dir = await initRepo();
    await commitFile(dir, 'f', 'a\n', 'c1');
    const c2 = await commitFile(dir, 'g', 'b\n', 'c2');
    await commitFile(dir, 'g', 'c\n', 'c3');

    // heal-state 放在仓库外，避免污染工作区（未跟踪文件也算脏）。
    const stateDir = await tempDir('rollback-heal-');
    const stateFile = join(stateDir, 'heal-state.json');
    await writeFile(stateFile, JSON.stringify({ lastGoodSha: c2 }));

    const h = harness(dir);
    const outcome = await runRollback({
      deps: { ...h.deps, readLastGoodSha: () => readLastGoodSha(stateFile) },
    });

    expect(outcome.status).toBe('rolled-back');
    if (outcome.status !== 'rolled-back') throw new Error('unreachable');
    expect(outcome.target).toBe(c2);
    expect(await git(dir, ['log', '-1', '--pretty=%s'])).toBe(`revert: 回退到 ${shortSha(c2)}（rollback）`);
    expect(h.logs.some((line) => line.includes('lastGoodSha'))).toBe(true);
  });

  it('工作区脏（含未跟踪文件）→ 拒绝且不动仓库', async () => {
    const dir = await initRepo();
    const c1 = await commitFile(dir, 'f', 'a\n', 'c1');
    const c2 = await commitFile(dir, 'f', 'b\n', 'c2');
    await writeFile(join(dir, 'f'), 'dirty\n');
    await writeFile(join(dir, 'untracked.txt'), 'x\n');
    const h = harness(dir);

    const outcome = await runRollback({ arg: c1, deps: h.deps });

    expect(outcome.status).toBe('error');
    if (outcome.status !== 'error') throw new Error('unreachable');
    expect(outcome.message).toContain('工作区有未提交改动');
    expect(await git(dir, ['rev-parse', 'HEAD'])).toBe(c2);
    expect(await git(dir, ['rev-list', '--count', 'HEAD'])).toBe('2');
    expect(await readFile(join(dir, 'f'), 'utf8')).toBe('dirty\n');
    expect(h.pnpmCalls).toEqual([]);
    expect(h.restart).not.toHaveBeenCalled();
  });

  it('流水线失败 → reset --hard 恢复到操作前的 HEAD', async () => {
    const dir = await initRepo();
    const c1 = await commitFile(dir, 'f', 'a\n', 'c1');
    const c2 = await commitFile(dir, 'f', 'b\n', 'c2');
    const h = harness(dir, { release: 'fail' });

    const outcome = await runRollback({ arg: c1, deps: h.deps });

    expect(outcome.status).toBe('error');
    if (outcome.status !== 'error') throw new Error('unreachable');
    expect(outcome.message).toContain('流水线失败');
    expect(outcome.message).toContain('reset --hard');
    expect(outcome.message).toContain(shortSha(c2));

    // revert 提交被撤销，仓库与内容都回到操作前。
    expect(await git(dir, ['rev-parse', 'HEAD'])).toBe(c2);
    expect(await git(dir, ['rev-list', '--count', 'HEAD'])).toBe('2');
    expect(await readFile(join(dir, 'f'), 'utf8')).toBe('b\n');
    expect(await git(dir, ['status', '--porcelain'])).toBe('');
    expect(h.restart).not.toHaveBeenCalled();

    // 真正跑到了 pnpm（typecheck 就失败）。
    expect(h.pnpmCalls).toEqual([['typecheck']]);
  });

  it('revert 失败（历史里有无法直接 revert 的 merge 提交）→ abort 后无半成品', async () => {
    const dir = await initRepo();
    const root = await commitFile(dir, 'f', 'base\n', 'c1');
    await git(dir, ['checkout', '-q', '-b', 'feat']);
    await commitFile(dir, 'h', 'h\n', 'cf');
    await git(dir, ['checkout', '-q', 'main']);
    await commitFile(dir, 'i', 'i\n', 'c2');
    await git(dir, ['merge', '-q', '--no-edit', 'feat']);
    await commitFile(dir, 'j', 'one\n', 'c4');
    const tip = await commitFile(dir, 'j', 'two\n', 'c5');

    const h = harness(dir);
    const outcome = await runRollback({ arg: root, deps: h.deps });

    expect(outcome.status).toBe('error');
    if (outcome.status !== 'error') throw new Error('unreachable');
    expect(outcome.message).toContain('git revert');
    expect(outcome.message).toContain('revert --abort');

    // 没有留下半成品：HEAD 原地、工作区干净、无 sequencer/REVERT_HEAD 残留。
    expect(await git(dir, ['rev-parse', 'HEAD'])).toBe(tip);
    expect(await git(dir, ['status', '--porcelain'])).toBe('');
    expect(existsSync(join(dir, '.git', 'REVERT_HEAD'))).toBe(false);
    expect(existsSync(join(dir, '.git', 'sequencer'))).toBe(false);
    expect(await readFile(join(dir, 'j'), 'utf8')).toBe('two\n');
    expect(await readFile(join(dir, 'h'), 'utf8')).toBe('h\n');
    expect(h.pnpmCalls).toEqual([]);
    expect(h.restart).not.toHaveBeenCalled();
  });

  it('revert 冲突（桩）→ 先 git revert --abort 再 reset --hard 兜底', async () => {
    const dir = await initRepo();
    const c1 = await commitFile(dir, 'f', 'a\n', 'c1');
    const c2 = await commitFile(dir, 'f', 'b\n', 'c2');
    const h = harness(dir);

    const gitCalls: string[] = [];
    const exec: ReleaseExec = async (command, args, options) => {
      gitCalls.push([command, ...args].join(' '));
      if (command === 'git' && args[0] === 'revert' && args[1] === '--no-commit') {
        throw Object.assign(new Error('conflict'), {
          code: 1,
          stderr: 'CONFLICT (content): Merge conflict in f\n',
        });
      }
      return h.deps.exec(command, args, options);
    };

    const outcome = await runRollback({ arg: c1, deps: { ...h.deps, exec } });

    expect(outcome.status).toBe('error');
    if (outcome.status !== 'error') throw new Error('unreachable');
    expect(outcome.message).toContain('CONFLICT');
    expect(gitCalls).toContain('git revert --abort');
    expect(gitCalls).toContain(`git reset --hard ${c2}`);
    expect(await git(dir, ['rev-parse', 'HEAD'])).toBe(c2);
    expect(await git(dir, ['status', '--porcelain'])).toBe('');
    expect(h.restart).not.toHaveBeenCalled();
  });

  it('已经在目标提交上 → noop，不跑流水线也不重启', async () => {
    const dir = await initRepo();
    await commitFile(dir, 'f', 'a\n', 'c1');
    const c2 = await commitFile(dir, 'f', 'b\n', 'c2');
    const h = harness(dir);

    const outcome = await runRollback({ arg: c2, deps: h.deps });

    expect(outcome).toEqual({ status: 'noop', message: expect.stringContaining('无需回退') });
    expect(await git(dir, ['rev-list', '--count', 'HEAD'])).toBe('2');
    expect(h.pnpmCalls).toEqual([]);
    expect(h.restart).not.toHaveBeenCalled();
  });

  it('无参数且只有一个提交 → no-target 报错', async () => {
    const dir = await initRepo();
    await commitFile(dir, 'f', 'a\n', 'c1');
    const h = harness(dir);

    const outcome = await runRollback({ deps: h.deps });

    expect(outcome.status).toBe('error');
    if (outcome.status !== 'error') throw new Error('unreachable');
    expect(outcome.message).toContain('没有可回退的历史提交');
    expect(h.restart).not.toHaveBeenCalled();
  });

  it('显式参数解析不了 → 报错且不动仓库', async () => {
    const dir = await initRepo();
    const c1 = await commitFile(dir, 'f', 'a\n', 'c1');
    const h = harness(dir);

    const outcome = await runRollback({ arg: 'does-not-exist', deps: h.deps });

    expect(outcome.status).toBe('error');
    if (outcome.status !== 'error') throw new Error('unreachable');
    expect(outcome.message).toContain('无法解析回退目标');
    expect(await git(dir, ['rev-parse', 'HEAD'])).toBe(c1);
    expect(h.pnpmCalls).toEqual([]);
  });
});

// === CLI 包装 ===

describe('runRollbackCli', () => {
  it('noop → 正常返回（退出码 0）', async () => {
    const dir = await initRepo();
    const head = await commitFile(dir, 'f', 'a\n', 'c1');
    const h = harness(dir);
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => {
      throw new Error('should not exit');
    }) as never);

    await runRollbackCli(head, h.deps);

    expect(exitSpy).not.toHaveBeenCalled();
    expect(logSpy.mock.calls.flat().join('\n')).toContain('无需回退');
  });

  it('error → 打印错误并 exit(1)', async () => {
    const dir = await initRepo();
    await commitFile(dir, 'f', 'a\n', 'c1');
    const h = harness(dir);
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
      throw new Error(`exit:${code}`);
    }) as never);

    await expect(runRollbackCli('bad-ref', h.deps)).rejects.toThrow('exit:1');

    expect(exitSpy).toHaveBeenCalledWith(1);
    expect(errSpy.mock.calls.flat().join('\n')).toContain('无法解析回退目标');
  });
});
