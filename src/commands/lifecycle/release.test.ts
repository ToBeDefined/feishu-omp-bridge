import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Mock } from 'vitest';
import type { CommandContext } from '../index';
import { releaseHandlers } from './release';
import { runRelease, type ReleaseResult } from '../../release/run';

vi.mock('../../release/run', () => ({ runRelease: vi.fn() }));
vi.mock('../../core/logger', () => ({
  log: { info: vi.fn(), fail: vi.fn(), warn: vi.fn() },
}));

function makeCtx(): { ctx: CommandContext; sent: string[]; restartProcess: Mock } {
  const sent: string[] = [];
  const restartProcess = vi.fn(async () => true);
  const ctx = {
    channel: {
      send: async (_chatId: string, payload: { markdown?: string }) => {
        sent.push(payload.markdown ?? '');
      },
    },
    msg: { chatId: 'oc_1', messageId: 'om_1', content: '' },
    scope: 'oc_1',
    chatMode: 'p2p',
    sessions: {},
    workspaces: {},
    agent: {},
    activeRuns: {},
    controls: { restartProcess },
  } as unknown as CommandContext;
  return { ctx, sent, restartProcess };
}

describe('/release', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('reports start, builds, then restarts on success', async () => {
    vi.mocked(runRelease).mockResolvedValue({ ok: true });
    const { ctx, sent, restartProcess } = makeCtx();
    await releaseHandlers['/release']!('', ctx);
    expect(sent[0]).toContain('开始发布');
    expect(sent[1]).toContain('构建成功');
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
    expect(sent[1]).toContain('发布失败于');
    expect(sent[1]).toContain('2 failed');
    expect(restartProcess).not.toHaveBeenCalled();
  });

  it('mentions a missing pnpm when reported', async () => {
    vi.mocked(runRelease).mockResolvedValue({ ok: false, step: 'typecheck', pnpmMissing: true });
    const { ctx, sent } = makeCtx();
    await releaseHandlers['/release']!('', ctx);
    expect(sent[1]).toContain('找不到 `pnpm`');
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
