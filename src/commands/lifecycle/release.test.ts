import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Mock } from 'vitest';
import type { CommandContext } from '../index';
import { releaseHandlers, waitForRunsToDrain } from './release';
import { runRelease, type ReleaseResult } from '../../release/run';
import { markOnlineNotice } from '../../bot/online-notify';

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
vi.mock('../../card/managed', () => ({
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

function makeCtx(): { ctx: CommandContext; sent: string[]; restartProcess: Mock } {
  h.sent.length = 0;
  const restartProcess = vi.fn(async () => true);
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
    // 发布前要等 run 排空：这里视为空闲（排空行为另有单测）。
    activeRuns: { idle: () => true },
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
    expect(markOnlineNotice).toHaveBeenCalledWith('oc_1', 'skip', undefined, 'om_card');
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
});

describe('waitForRunsToDrain', () => {
  it('已经空闲时立即返回', async () => {
    const drained = await waitForRunsToDrain({ idle: () => true }, 0);
    expect(drained).toBe(true);
  });

  it('超时后返回 false（不无限等）', async () => {
    vi.useFakeTimers();
    try {
      const drained = waitForRunsToDrain({ idle: () => false }, 1000);
      await vi.advanceTimersByTimeAsync(1200);
      expect(await drained).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it('run 排空后返回 true', async () => {
    vi.useFakeTimers();
    try {
      let running = true;
      const drained = waitForRunsToDrain({ idle: () => !running }, 10_000);
      await vi.advanceTimersByTimeAsync(600);
      running = false;
      await vi.advanceTimersByTimeAsync(600);
      expect(await drained).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });
});
