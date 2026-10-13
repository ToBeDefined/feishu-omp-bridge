import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Mock } from 'vitest';
import type { CommandContext } from '../index';
import { releaseHandlers, waitForRunsToDrain, RELEASE_DRAIN_MAX_MS, type DrainProgress } from './release';
import { runRelease, type ReleaseResult } from '../../release/run';
import { markOnlineNotice } from '../../bot/online-notify';

// 排空超时用例要把假时钟推 5 分钟（500ms 轮询 × 600 次 + 每次的阅卡），满负载
// 跑全量（80 个文件并行）时会超过默认 5s —— 与 rollback.test.ts 同样给足余量。
vi.setConfig({ testTimeout: 60_000 });

vi.mock('../../release/run', () => ({
  runRelease: vi.fn(),
  repoRoot: vi.fn(() => '/repo'),
  RELEASE_STEPS: [
    { name: 'typecheck', args: ['typecheck'], timeoutMs: 60_000 },
    { name: 'test', args: ['test'], timeoutMs: 120_000 },
    { name: 'build', args: ['build'], timeoutMs: 120_000 },
  ],
}));
vi.mock('../../bot/online-notify', () => ({ markOnlineNotice: vi.fn(), clearOnlineNotice: vi.fn() }));
vi.mock('../../core/logger', () => ({
  log: { info: vi.fn(), fail: vi.fn(), warn: vi.fn() },
}));

// Managed-card path (sendManagedCard / updateManagedCard) records into the
// same array as channel.send so assertions cover both text and card output.
const h = vi.hoisted(() => ({ sent: [] as string[] }));
vi.mock('../../card/managed', () => ( {
  assertApiOk: vi.fn(),
  managedSequence: vi.fn(() => undefined),
  adoptManagedCard: vi.fn(),
  sendManagedCard: async (...args: unknown[]) => {
    h.sent.push(JSON.stringify(args[2]));
    return { messageId: 'om_card' };
  },
  updateManagedCard: async (...args: unknown[]) => {
    h.sent.push(JSON.stringify(args[2]));
    return {};
  },
  forgetManagedCard: async () => {},
}));

/** `running`：true/false 视为 1/0 个在跑的 run；传函数可以控制排空过程中的数量变化。 */
function makeCtx(
  running: boolean | (() => number) = false,
): { ctx: CommandContext; sent: string[]; restartProcess: Mock } {
  h.sent.length = 0;
  const restartProcess = vi.fn(async () => true);
  const count = typeof running === 'function' ? running : () => (running ? 1 : 0);
  const ctx = {
    channel: {
      send: async (_chatId: string, payload: { markdown?: string }) => {
        h.sent.push(payload.markdown ?? '');
      },
    },
    msg: { chatId: 'oc_1', messageId: 'om_1', content: '' },
    scope: 'oc_1',
    chatMode: 'p2p',
    sessions: {},
    workspaces: {},
    agent: {},
    // 发布前要等 run 排空：默认视为空闲（排空行为另有单测）；busy=true 模拟有 run 在跑。
    activeRuns: { idle: () => count() === 0, runningCount: count },
    controls: { restartProcess },
  } as unknown as CommandContext;
  return { ctx, sent: h.sent, restartProcess };
}

describe('/release', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('reports start, builds, then restarts on success', async () => {
    vi.mocked(runRelease).mockResolvedValue({ ok: true });
    const { ctx, sent, restartProcess } = makeCtx();
    await releaseHandlers['/release']!('', ctx);
    expect(sent[0]).toContain('正在发布');
    // Pre-boot state must NOT claim success — the new process confirms it.
    expect(sent.at(-1)).toContain('构建完成，正在重启加载新产物');
    expect(sent.at(-1)).not.toContain('已发布上线');
    expect(markOnlineNotice).toHaveBeenCalledWith('oc_1', 'skip', undefined, 'om_card', undefined, undefined);
    expect(restartProcess).toHaveBeenCalledTimes(1);
  });

  it('reports a failing step without restarting', async () => {
    vi.mocked(runRelease).mockResolvedValue({
      ok: false,
      step: 'test',
      exitCode: 1,
      output: '2 failed',
    });
    const { ctx, sent, restartProcess } = makeCtx();
    await releaseHandlers['/release']!('', ctx);
    expect(sent.at(-1)).toContain('发布失败于');
    expect(sent.at(-1)).toContain('2 failed');
    expect(markOnlineNotice).not.toHaveBeenCalled();
    expect(restartProcess).not.toHaveBeenCalled();
  });

  it('mentions a missing pnpm when reported', async () => {
    vi.mocked(runRelease).mockResolvedValue({ ok: false, step: 'typecheck', pnpmMissing: true });
    const { ctx, sent } = makeCtx();
    await releaseHandlers['/release']!('', ctx);
    expect(sent.at(-1)).toContain('找不到 pnpm');
  });

  it('falls back to in-process reconnect when not under launchd', async () => {
    vi.mocked(runRelease).mockResolvedValue({ ok: true });
    const { ctx, sent, restartProcess } = makeCtx();
    restartProcess.mockResolvedValue(false);
    await releaseHandlers['/release']!('', ctx);
    expect(sent.at(-1)).toContain('已重新连接');
  });

  it('blocks a re-entrant release while one is running', async () => {
    let resolveFirst!: (v: ReleaseResult) => void;
    vi.mocked(runRelease).mockImplementationOnce(
      () => new Promise<ReleaseResult>((resolvePromise) => {
        resolveFirst = resolvePromise;
      }),
    );
    const { ctx, sent, restartProcess } = makeCtx();

    const first = releaseHandlers['/release']!('', ctx);
    await releaseHandlers['/release']!('', ctx);
    expect(sent.at(-1)).toContain('已有一次发布');

    resolveFirst({ ok: true });
    await first;
    expect(restartProcess).toHaveBeenCalledTimes(1);
  });
  it('force：有 run 在跑也不等排空，立即重启并在卡片上写明', async () => {
    vi.mocked(runRelease).mockResolvedValue({ ok: true });
    const { ctx, sent, restartProcess } = makeCtx(true);
    await releaseHandlers['/release']!('force', ctx);
    expect(sent.at(-1)).toContain('强制重启');
    // 说清代价：这次 force 会中断几个在跑的会话。
    expect(sent.at(-1)).toContain('中断 1 个在跑的会话');
    expect(restartProcess).toHaveBeenCalledTimes(1);
    // 非强制路径由 waitForRunsToDrain 的单测覆盖（这里若没跳过排空会等满 5 分钟）。
  });

  it('force 且没有在跑的 run：不写「中断 0 个」', async () => {
    vi.mocked(runRelease).mockResolvedValue({ ok: true });
    const { ctx, sent } = makeCtx(false);
    await releaseHandlers['/release']!('force', ctx);
    expect(sent.at(-1)).toContain('无在跑会话');
    expect(sent.join('')).not.toContain('中断 0 个');
  });

  it('排空阶段：把「等在跑的会话收尾」当当前步骤推上卡，数量变化才刷新', async () => {
    vi.useFakeTimers();
    try {
      vi.mocked(runRelease).mockResolvedValue({ ok: true });
      let running = 2;
      const { ctx, sent } = makeCtx(() => running);
      const done = releaseHandlers['/release']!('', ctx);

      // 进入排空就上报一次（不用等满节流窗口）。
      await vi.advanceTimersByTimeAsync(500);
      expect(sent.at(-1)).toContain('等待 2 个在跑的会话收尾（最多 5 分钟）');
      const afterFirst = sent.length;

      running = 1;
      await vi.advanceTimersByTimeAsync(1500); // t=2000，踩到 2s 节流下限
      expect(sent.at(-1)).toContain('等待 1 个在跑的会话收尾');
      expect(sent.length).toBeGreaterThan(afterFirst);

      running = 0;
      await vi.advanceTimersByTimeAsync(2000);
      await done;
      // 收尾完成 → 卡回到「构建完成，正在重启」，等待态不许留在屏幕上。
      expect(sent.at(-1)).toContain('构建完成，正在重启加载新产物');
      expect(sent.at(-1)).not.toContain('等待');
    } finally {
      vi.useRealTimers();
    }
  });

  it('没有在跑的 run 时不出现等待文案', async () => {
    vi.mocked(runRelease).mockResolvedValue({ ok: true });
    const { ctx, sent } = makeCtx(false);
    await releaseHandlers['/release']!('', ctx);
    expect(sent.some((s) => s.includes('等待'))).toBe(false);
  });

  it('排空超时：卡上写明「超时」与被中断数量，不再只写日志', async () => {
    vi.useFakeTimers();
    try {
      vi.mocked(runRelease).mockResolvedValue({ ok: true });
      const { ctx, sent } = makeCtx(() => 2);
      const done = releaseHandlers['/release']!('', ctx);
      await vi.advanceTimersByTimeAsync(RELEASE_DRAIN_MAX_MS + 1000);
      await done;
      const last = sent.at(-1)!;
      expect(last).toContain('超时');
      expect(last).toContain('2 个在跑任务被中断');
      // 超时不能自称正常收尾，也不能提前宣布成功。
      expect(last).not.toContain('已发布上线');
    } finally {
      vi.useRealTimers();
    }
  });

  it('force 也不能绕过「失败即止」：流水线失败就不重启', async () => {
    vi.mocked(runRelease).mockResolvedValue({
      ok: false,
      step: 'test',
      exitCode: 1,
      output: 'boom',
    });
    const { ctx, sent, restartProcess } = makeCtx(true);
    await releaseHandlers['/release']!('force', ctx);
    expect(sent.at(-1)).toContain('发布失败于');
    expect(restartProcess).not.toHaveBeenCalled();
  });

  it('force 的别名 --force / -f 等价', async () => {
    vi.mocked(runRelease).mockResolvedValue({ ok: true });
    for (const arg of ['--force', '-f', 'FORCE']) {
      const { ctx, restartProcess } = makeCtx(true);
      await releaseHandlers['/release']!(arg, ctx);
      expect(restartProcess).toHaveBeenCalledTimes(1);
    }
  });

  it('无法识别的参数：只报用法，不发布也不重启', async () => {
    const { ctx, sent, restartProcess } = makeCtx();
    await releaseHandlers['/release']!('frce', ctx);
    expect(sent.at(-1)).toContain('无法识别的参数');
    expect(runRelease).not.toHaveBeenCalled();
    expect(restartProcess).not.toHaveBeenCalled();
  });
});

describe('waitForRunsToDrain', () => {
  it('已经空闲时立即返回', async () => {
    const drained = await waitForRunsToDrain({ idle: () => true, runningCount: () => 0 }, 0);
    expect(drained).toBe(true);
  });

  it('超时后返回 false（不无限等）', async () => {
    vi.useFakeTimers();
    try {
      const drained = waitForRunsToDrain({ idle: () => false, runningCount: () => 2 }, 1000);
      await vi.advanceTimersByTimeAsync(1200);
      expect(await drained).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it('run 排空后返回 true', async () => {
    vi.useFakeTimers();
    try {
      let running = 1;
      const drained = waitForRunsToDrain(
        { idle: () => running === 0, runningCount: () => running },
        10_000,
      );
      await vi.advanceTimersByTimeAsync(600);
      running = 0;
      await vi.advanceTimersByTimeAsync(600);
      expect(await drained).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it('等待期间回调在跑数量与已等时长，并按 ≥2s 节流', async () => {
    vi.useFakeTimers();
    try {
      let running = 3;
      const seen: DrainProgress[] = [];
      const drained = waitForRunsToDrain(
        { idle: () => running === 0, runningCount: () => running },
        10_000,
        {
          onWait: (p) => {
            seen.push(p);
          },
        },
      );
      // 进入等待立刻报一次：卡片上马上就有「在等谁」，不用干等 2 秒。
      expect(seen).toEqual([{ runningCount: 3, waitedMs: 0, timeoutMs: 10_000 }]);

      // 500ms 的轮询不写卡片：patch 有配额。
      await vi.advanceTimersByTimeAsync(500);
      expect(seen).toHaveLength(1);

      running = 2;
      await vi.advanceTimersByTimeAsync(1500); // t=2000
      expect(seen).toHaveLength(2);
      expect(seen[1]).toEqual({ runningCount: 2, waitedMs: 2000, timeoutMs: 10_000 });

      running = 0;
      await vi.advanceTimersByTimeAsync(1000);
      expect(await drained).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });
});
