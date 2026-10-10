import { configDefaults, defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Worktrees live inside the repo (`.worktrees/`, gitignored). Vitest's
    // default include is `**/*.test.ts`, so an active worktree made the MAIN
    // tree run its own suite twice (132 files / 1462 tests instead of 66/731)
    // — a silently wrong baseline. Exclude the worktree directory.
    exclude: [...configDefaults.exclude, '.worktrees/**'],
  },
});
