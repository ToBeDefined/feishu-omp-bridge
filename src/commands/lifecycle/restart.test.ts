import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Mock } from 'vitest';
import type { CommandContext } from '../index';
import { restartHandlers } from './restart';
import { RELEASE_DRAIN_MAX_MS } from './release';
import { clearOnlineNotice, markOnlineNotice } from '../../bot/online-notify';

vi.mock('../../bot/online-notify', () => ({ markOnlineNotice: vi.fn(), clearOnlineNotice: vi.fn() }));
vi.mock('../../core/logger', () => ({
  log: { info: vi.fn(), fail: vi.fn(), warn: vi.fn() },
}));

// 排空超时用例要把假时钟推 5 分钟（500ms 轮询 × 600 次 + 每次的阅卡），满负载
// 跑全量（80 个文件并行）时会超过默认 5s —— 与 rollback.test.ts 同样给足余量。
vi.setConfig({ testTimeout: 60_000 });

// 卡片路径（sendManagedCard / updateManagedCard）记进同一个数组：断言不区分
// 「首发卡」与「原地更新的卡」，只看屏幕上最后是什么。文本回复单独记，用来覆盖
// 卡片发不出去时的兜底回执。
const h = vi.hoisted(() => ({
  cards: [] as string[],
  texts: [] as string[],
  cardSendFails: false,
}));
vi.mock('../../card/managed', () => ({
  sendManagedCard: async (...args: unknown[]) => {
    if (h.cardSendFails) throw new Error('card send failed');
    h.cards.push(JSON.stringify(args[2]));
    return { messageId: 'om_card' };
  },
  updateManagedCard: async (...args: unknown[]) => {
    h.cards.push(JSON.stringify(args[2]));
    return {};
  },
}));

/** `runningCount`：数字直接当在跑的 run 数；传函数可控制排空过程中的数量变化。 */
function makeCtx(
  realRestart: boolean,
  runningCount: number | (() => number) = 0,
): { ctx: CommandContext; restartProcess: Mock } {
  const count = typeof runningCount === 'function' ? runningCount : (): number => runningCount;
  const restartProcess = vi.fn(async () => realRestart);
  const ctx = {
    channel: {
      send: async (_chatId: string, payload: { markdown?: string }) => {
        h.texts.push(payload.markdown ?? '');
      },
    },
    msg: { chatId: 'oc_1', messageId: 'om_1' },
    controls: { restartProcess },
    scope: 'oc_1',
    chatMode: 'p2p',
    // 重启前要等 run 排空：默认空闲（排空行为另有单测）。
    activeRuns: { idle: () => count() === 0, runningCount: count },
  } as unknown as CommandContext;
  return { ctx, restartProcess };
}

describe('/restart command', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    h.cards.length = 0;
    h.texts.length = 0;
    h.cardSendFails = false;
  });

  it('marks the requesting chat so the boot notice reaches it, and does not ack a real restart', async () => {
    const { ctx } = makeCtx(true);
    await restartHandlers['/restart']!('', ctx);
    // 起手卡就是「正在重启」：没有在跑的 run 时不显示等待态。
    expect(h.cards[0]).toContain('正在重启');
    expect(h.cards[0]).not.toContain('等待');
    // The process dies mid-restart: no boot-time notice can be sent from here,
    // so the marker is what tells the relaunched daemon to confirm.
    expect(h.cards.at(-1)).not.toContain('重启完成');
    expect(h.texts.some((t) => t.includes('🚀'))).toBe(false);
    expect(markOnlineNotice).toHaveBeenCalledWith('oc_1', 'notify', undefined, 'om_card');
    expect(clearOnlineNotice).not.toHaveBeenCalled();
  });

  it('acks with 🚀 on the in-process fallback and drops the unconsumed marker', async () => {
    const { ctx } = makeCtx(false);
    await restartHandlers['/restart']!('', ctx);
    expect(h.cards.at(-1)).toContain('重启完成');
    expect(h.texts.some((t) => t.includes('🚀'))).toBe(false);
    expect(clearOnlineNotice).toHaveBeenCalledTimes(1);
  });

  it('force：有 run 在跑也不等排空，立即重启并写明会中断几个', async () => {
    const { ctx, restartProcess } = makeCtx(true, 3);
    await restartHandlers['/restart']!('force', ctx);
    // 没等排空才会这么快返回（非强制路径会等满 5 分钟排空上限）。
    expect(restartProcess).toHaveBeenCalledTimes(1);
    expect(h.cards[0]).toContain('强制重启');
    expect(h.cards[0]).toContain('中断 3 个在跑的会话');
    expect(markOnlineNotice).toHaveBeenCalledWith('oc_1', 'notify', undefined, 'om_card');
  });

  it('force 且没有在跑的 run：不写「中断 0 个」', async () => {
    const { ctx, restartProcess } = makeCtx(true, 0);
    await restartHandlers['/restart']!('force', ctx);
    expect(restartProcess).toHaveBeenCalledTimes(1);
    expect(h.cards[0]).toContain('无在跑会话');
    expect(h.cards.join('')).not.toContain('中断 0 个');
  });

  it('非 force 有 run 在跑：先写「等 N 个收尾」，数量变化刷新，收尾后切回「服务即将重启」', async () => {
    vi.useFakeTimers();
    try {
      let running = 2;
      const { ctx, restartProcess } = makeCtx(true, () => running);
      const done = restartHandlers['/restart']!('', ctx);

      await vi.advanceTimersByTimeAsync(500);
      expect(h.cards.at(-1)).toContain('正在等待 2 个在跑的会话收尾');
      expect(h.cards.at(-1)).toContain('收尾');
      expect(h.cards.at(-1)).toContain('最多 5 分钟');

      running = 1;
      await vi.advanceTimersByTimeAsync(1500); // t=2000：踩到 2s 节流下限
      expect(h.cards.at(-1)).toContain('正在等待 1 个在跑的会话收尾');

      running = 0;
      await vi.advanceTimersByTimeAsync(2000);
      await done;
      // 排空结束 = 真要重启了：等待态必须切回现有文案。
      expect(h.cards.at(-1)).toContain('服务即将重启');
      expect(h.cards.at(-1)).not.toContain('等待');
      expect(restartProcess).toHaveBeenCalledTimes(1);
      expect(markOnlineNotice).toHaveBeenCalledWith('oc_1', 'notify', undefined, 'om_card');
    } finally {
      vi.useRealTimers();
    }
  });

  it('排空超时：卡上写明超时与被中断数量，而非直接「服务即将重启」', async () => {
    vi.useFakeTimers();
    try {
      const { ctx, restartProcess } = makeCtx(true, 2);
      const done = restartHandlers['/restart']!('', ctx);
      await vi.advanceTimersByTimeAsync(RELEASE_DRAIN_MAX_MS + 1000);
      await done;
      const last = h.cards.at(-1)!;
      expect(last).toContain('排空超时');
      expect(last).toContain('2 个在跑任务被中断');
      expect(last).not.toContain('服务即将重启');
      expect(restartProcess).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('无法识别的参数：只报用法，不重启也不留标记', async () => {
    const { ctx } = makeCtx(true);
    await restartHandlers['/restart']!('now', ctx);
    expect(h.texts.some((t) => t.includes('无法识别的参数'))).toBe(true);
    expect(markOnlineNotice).not.toHaveBeenCalled();
  });

  it('reports failure when restartProcess throws and drops the marker', async () => {
    const { ctx, restartProcess } = makeCtx(false);
    restartProcess.mockRejectedValue(new Error('boom'));
    await restartHandlers['/restart']!('', ctx);
    expect(h.cards.at(-1)).toContain('重启失败');
    expect(clearOnlineNotice).toHaveBeenCalledTimes(1);
  });

  it('起手卡发不出去时退回文本回执，且不带标记的消息 id', async () => {
    const { ctx } = makeCtx(true);
    h.cardSendFails = true;
    await restartHandlers['/restart']!('', ctx);
    expect(h.texts.some((t) => t.includes('🔄 正在重启…'))).toBe(true);
    expect(markOnlineNotice).toHaveBeenCalledWith('oc_1', 'notify', undefined, undefined);
  });
});
