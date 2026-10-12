import { configDefaults, defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Worktrees live inside the repo (`.worktrees/`, gitignored). Vitest's
    // default include is `**/*.test.ts`, so an active worktree made the MAIN
    // tree run its own suite twice (132 files / 1462 tests instead of 66/731)
    // — a silently wrong baseline. Exclude the worktree directory.
    exclude: [...configDefaults.exclude, '.worktrees/**'],
    // 测试绝不写真实 ~/.feishu-omp-bridge（见 test/setup-paths.ts 的说明）。
    setupFiles: ['./test/setup-paths.ts'],
    // 限制 worker 池：`/release` 是在 bridge 自己这台机器上跑测试，默认
    // maxWorkers = 核数-1（16 核机器 = 15 个 worker + 测试内 spawn 的子进程，
    // 峰值 17 个 node 进程）会在发布瞬间把 CPU 拉满；且一旦流水线的测试步骤
    // 被 kickstart 打断 teardown，这些 worker 会以孤儿身份残留。6 个足够
    // 在 120s 步骤超时内跑完全量（实测 ~15s）。
    maxWorkers: 6,
    minWorkers: 1,
  },
});
