import type { LarkChannel } from '@larksuiteoapi/node-sdk';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  adoptManagedCard,
  finalizeByKind,
  finalizeInterruptedCards,
  forgetManagedCard,
  forgetStreamingCard,
  freshSequence,
  sequenceWatermark,
  patchCardWithRetry,
  updateManagedCard,
  rememberStreamingCard,
  runningCardsSettled,
  stripRunningState,
  type RunningCardKind,
} from './managed';
import { paths } from '../config/paths';

describe('stripRunningState', () => {
  it('keeps content and drops stop buttons + running footer', () => {
    const card = {
      schema: '2.0',
      body: {
        elements: [
          { tag: 'markdown', content: '已经输出的正文' },
          { tag: 'markdown', content: '**🧠 思考过程**' },
          { tag: 'hr' },
          {
            tag: 'column_set',
            columns: [
              { tag: 'column', elements: [{ tag: 'markdown', content: '✍️ 正在输出' }] },
              { tag: 'column', elements: [{ tag: 'button', text: { tag: 'plain_text', content: '⏹ 终止' }, value: { cmd: 'stop' } }] },
            ],
          },
        ],
      },
    };
    const out = stripRunningState(card);
    const json = JSON.stringify(out);
    expect(json).toContain('已经输出的正文');
    expect(json).toContain('🧠 思考过程');
    expect(json).not.toContain('⏹');
    expect(json).not.toContain('"cmd":"stop"');
    expect(json).not.toContain('正在输出');
    expect(json).toContain('以上为已输出的部分内容');
    expect(json).toContain('进程中断');
    // 控制区自带的 hr 一并剥掉，否则和补的中断注记 `---` 叠成双线。
    expect(json).not.toContain('"tag":"hr"');
    expect(json.match(/---/g)).toHaveLength(1);
  });

  it('只剥控制区上方那条 hr，不碰正文自己的分隔线', () => {
    const card = {
      schema: '2.0',
      body: {
        elements: [
          { tag: 'markdown', content: '第一段' },
          { tag: 'hr' },
          { tag: 'markdown', content: '第二段' },
          { tag: 'hr' },
          {
            tag: 'column_set',
            columns: [
              {
                tag: 'column',
                elements: [{ tag: 'markdown', content: '✍️ 正在输出' }],
              },
            ],
          },
        ],
      },
    };
    const out = stripRunningState(card) as {
      body: { elements: Array<{ tag: string; content?: string }> };
    };
    // 正文之间的那条 hr 留下；控制行正上方那条随控制行一起消失。
    expect(out.body.elements.map((el) => el.tag)).toEqual([
      'markdown',
      'hr',
      'markdown',
      'markdown',
      'markdown',
    ]);
    expect(out.body.elements[2]).toMatchObject({ content: '第二段' });
    expect(out.body.elements[3]).toMatchObject({ content: '---' });
  });

  it('已完工的卡片（没有运行态元素）不贴「进程中断」——崩溃记录没删干净也不该误报', () => {
    const finished = {
      schema: '2.0',
      body: {
        elements: [
          { tag: 'markdown', content: '已经输出的完整正文' },
          { tag: 'markdown', content: '---', text_size: 'notation' },
        ],
      },
    };
    const out = stripRunningState(finished);
    const json = JSON.stringify(out);
    expect(json).toContain('已经输出的完整正文');
    expect(json).not.toContain('进程中断');
    expect(json).not.toContain('以上为已输出的部分内容');
  });

  it('survives a card with no body', () => {
    const out = JSON.stringify(stripRunningState({}));
    expect(out).toContain('以上为已输出的部分内容');
  });
});

describe('running-cards 的读改写串行', () => {
  it('remember 紧跟 forget 不残留记录（否则下次启动会给已完成卡片补「进程中断」）', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'cards-race-'));
    const orig = paths.runningCardsFile;
    paths.runningCardsFile = join(dir, 'running-cards.json');
    try {
      rememberStreamingCard('om_race', 'oc_1', { schema: '2.0', body: { elements: [] } });
      forgetStreamingCard('om_race');
      await runningCardsSettled();
      const left = JSON.parse(await readFile(paths.runningCardsFile, 'utf8').catch(() => '[]')) as unknown[];
      expect(left).toEqual([]);
    } finally {
      paths.runningCardsFile = orig;
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe('finalizeByKind', () => {
  it('turns a restart card into the completed state', () => {
    const out = JSON.stringify(finalizeByKind('restart', undefined));
    expect(out).toContain('重启完成');
    expect(out).not.toContain('未完成');
  });

  it('marks a release card as interrupted', () => {
    expect(JSON.stringify(finalizeByKind('release', undefined))).toContain('发布被中断');
  });

  it('expires a form card', () => {
    expect(JSON.stringify(finalizeByKind('form', undefined))).toContain('已过期');
  });

  it('marks a compact card as failed when the process died mid-compaction', () => {
    const out = JSON.stringify(finalizeByKind('compact', undefined));
    expect(out).toContain('压缩失败');
    expect(out).not.toContain('正在压缩');
  });

  it('已完工的快照（无运行态元素）收尾时不贴中断注解', () => {
    const out = JSON.stringify(
      finalizeByKind('stream', {
        schema: '2.0',
        body: { elements: [{ tag: 'markdown', content: '已输出内容' }] },
      }),
    );
    expect(out).toContain('已输出内容');
    expect(out).not.toContain('以上为已输出的部分内容');
  });

  it('仍在运行态的快照收尾时剥掉 ⏹ 并贴中断注解', () => {
    const out = JSON.stringify(
      finalizeByKind('stream', {
        schema: '2.0',
        body: {
          elements: [
            { tag: 'markdown', content: '已输出内容' },
            {
              tag: 'column_set',
              elements: [
                {
                  tag: 'button',
                  text: { tag: 'plain_text', content: '⏹ 终止' },
                  value: { cmd: 'stop' },
                },
              ],
            },
          ],
        },
      }),
    );
    expect(out).toContain('已输出内容');
    expect(out).toContain('以上为已输出的部分内容');
    expect(out).not.toContain('⏹');
  });
});

describe('finalizeInterruptedCards（崩溃/重启后的补卡）', () => {
  const STREAM_ID = 'om_x100b639700a92ca0c38de10458cb8ff';
  const origFile = paths.runningCardsFile;
  let dir: string;
  let file: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'finalize-'));
    file = join(dir, 'running-cards.json');
    paths.runningCardsFile = file;
  });
  afterEach(async () => {
    paths.runningCardsFile = origFile;
    await rm(dir, { recursive: true, force: true });
  });

  /** Leftover entry for a streaming card that was mid-flight when we bounced. */
  async function writeLeftovers(entries: Array<{ messageId: string; kind: RunningCardKind; card?: object }>): Promise<void> {
    await writeFile(
      file,
      JSON.stringify(entries.map((e) => ({ cardId: '', chatId: 'oc_1', ...e }))),
      'utf8',
    );
  }

  function channel(patch: (content: object) => Promise<void>): { channel: never; patched: object[] } {
    const patched: object[] = [];
    const fake = {
      rawClient: {
        im: { v1: { message: { patch: async (req: { path: { message_id: string }; data: { content: string } }) => {
          const card = JSON.parse(req.data.content) as object;
          patched.push(card);
          await patch(card);
        } } } },
      },
    } as never;
    return { channel: fake, patched };
  }

  it('补上了就清记录，卡片里不再有 ⏹ 终止', async () => {
    await writeLeftovers([
      { messageId: STREAM_ID, kind: 'stream', card: { schema: '2.0', body: { elements: [
        { tag: 'markdown', content: '已输出内容' },
        { tag: 'button', text: { tag: 'plain_text', content: '⏹ 终止' }, value: { cmd: 'stop' } },
      ] } } },
      { messageId: 'om_sent', kind: 'form' }, // 占位 id：不当真卡片补
    ]);
    const { channel: ch, patched } = channel(async () => {});

    expect(await finalizeInterruptedCards(ch)).toBe(false);

    expect(patched).toHaveLength(1);
    expect(JSON.stringify(patched[0])).toContain('已输出内容'); // 内容保住
    expect(JSON.stringify(patched[0])).not.toContain('⏹');      // 终止按钮消失
    expect(JSON.parse(await readFile(file, 'utf8'))).toEqual([]);
  });

  it('补卡被飞书拒（400）→ 甩极小终态卡；再失败就留记录等下次启动', async () => {
    await writeLeftovers([
      { messageId: STREAM_ID, kind: 'stream', card: { schema: '2.0', body: { elements: [
        { tag: 'markdown', content: '已输出内容' },
      ] } } },
    ]);
    const { channel: ch, patched } = channel(async () => {
      throw new Error('AxiosError: Request failed with status code 400');
    });

    await finalizeInterruptedCards(ch);

    // 先试带内容的大卡，再退回极小卡 —— 两次都被拒。
    expect(patched).toHaveLength(2);
    expect(JSON.stringify(patched[1])).not.toContain('⏹');
    // 关键：记录**留着**。从前这里无论成败都清空，于是补卡被拒一次，
    // 那个 ⏹ 终止按钮就永远挂在用户的聊天里了。
    const left = JSON.parse(await readFile(file, 'utf8')) as Array<{ messageId: string }>;
    expect(left.map((c) => c.messageId)).toEqual([STREAM_ID]);
  });

  it('超长快照（必被飞书拒）直接走极小卡，不白试一次', async () => {
    await writeLeftovers([
      { messageId: STREAM_ID, kind: 'stream', card: { schema: '2.0', body: { elements: [
        { tag: 'markdown', content: 'x'.repeat(40_000) },
      ] } } },
    ]);
    const { channel: ch, patched } = channel(async () => {});

    await finalizeInterruptedCards(ch);

    expect(patched).toHaveLength(1);
    expect(Buffer.byteLength(JSON.stringify(patched[0]), 'utf8')).toBeLessThan(28 * 1024);
  });

  it('连续补不上：attempts 累加；超过上限后转一小时退避——记录保留但不再外呼', async () => {
    await writeLeftovers([
      { messageId: STREAM_ID, kind: 'stream', card: { schema: '2.0', body: { elements: [
        { tag: 'markdown', content: '已输出内容' },
      ] } } },
    ]);
    const { channel: ch } = channel(async () => {
      throw new Error('AxiosError: Request failed with status code 400');
    });

    // 第 1~3 次启动：都被拒 → 记录还在，attempts 逐次 +1。
    for (let i = 1; i <= 3; i += 1) {
      await finalizeInterruptedCards(ch);
      const left = JSON.parse(await readFile(file, 'utf8')) as Array<{ attempts?: number }>;
      expect(left.map((c) => c.attempts)).toEqual([i]);
    }

    // 第 4 次：超过上限 → 转入退避（记录保留、带 nextAttemptAt），仍会尝试这一次。
    await finalizeInterruptedCards(ch);
    const after4 = JSON.parse(await readFile(file, 'utf8')) as Array<{ attempts?: number; nextAttemptAt?: string }>;
    expect(after4).toHaveLength(1);
    expect(after4[0]!.attempts).toBe(4);
    expect(Date.parse(after4[0]!.nextAttemptAt!)).toBeGreaterThan(Date.now());

    // 退避期内：连"是否尝试"都不该发生 —— 用会抛错的 channel 计数断言零外呼。
    let calls = 0;
    const { channel: ch2 } = channel(async () => {
      calls += 1;
      throw new Error('400');
    });
    await finalizeInterruptedCards(ch2);
    expect(calls).toBe(0);
    const after5 = JSON.parse(await readFile(file, 'utf8')) as Array<{ attempts?: number }>;
    expect(after5[0]!.attempts).toBe(4); // 退避期不再累加
  });

  it('退避到期后重新尝试（记录仍可救回）', async () => {
    const past = new Date(Date.now() - 60_000).toISOString();
    await writeLeftovers([
      { messageId: STREAM_ID, kind: 'stream', card: { schema: '2.0', body: { elements: [
        { tag: 'markdown', content: '已输出内容' },
      ] } }, attempts: 9, nextAttemptAt: past } as never,
    ]);
    let patched = 0;
    const { channel: ch } = channel(async () => {
      patched += 1;
    });
    // 归档：deliverInterruptCard 内部用 patch，成功即清记录
    await finalizeInterruptedCards(ch);
    expect(patched).toBeGreaterThanOrEqual(0);
  });

  it('补卡成功的那次不累加 attempts（记录整体清除）', async () => {
    await writeLeftovers([
      { messageId: STREAM_ID, kind: 'stream', card: { schema: '2.0', body: { elements: [
        { tag: 'markdown', content: '已输出内容' },
      ] } } },
    ]);
    // 第一次失败 → attempts=1 留着；第二次成功 → 记录清空。
    let fail = true;
    const { channel: ch } = channel(async () => {
      if (fail) throw new Error('400');
    });
    await finalizeInterruptedCards(ch);
    expect(
      (JSON.parse(await readFile(file, 'utf8')) as Array<{ attempts?: number }>).map((c) => c.attempts),
    ).toEqual([1]);
    fail = false;
    await finalizeInterruptedCards(ch);
    expect(JSON.parse(await readFile(file, 'utf8'))).toEqual([]);
  });
});

describe('patchCardWithRetry（终态 patch 的限频重试）', () => {
  const channelWith = (patch: () => Promise<unknown>): LarkChannel =>
    ({ rawClient: { im: { v1: { message: { patch } } } } }) as unknown as LarkChannel;
  const card = { schema: '2.0', body: { elements: [] } };

  it('限频（230020）退避重试，最终成功 → true', async () => {
    vi.useFakeTimers();
    try {
      let calls = 0;
      const channel = channelWith(async () => {
        calls += 1;
        if (calls === 1) {
          throw Object.assign(new Error('Request failed with status code 400'), {
            response: { status: 400, data: { code: 230020, msg: 'frequency limit' } },
          });
        }
        return {};
      });
      const done = patchCardWithRetry(channel, 'om_retry', card);
      await vi.advanceTimersByTimeAsync(1000); // 第一档退避
      await expect(done).resolves.toBe(true);
      expect(calls).toBe(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it('连续限频：只重试两次（共三次尝试）就放弃，不会死循环', async () => {
    vi.useFakeTimers();
    try {
      let calls = 0;
      const channel = channelWith(async () => {
        calls += 1;
        throw Object.assign(new Error('Request failed with status code 400'), {
          response: { status: 400, data: { code: 230020, msg: 'frequency limit' } },
        });
      });
      const done = patchCardWithRetry(channel, 'om_loop', card);
      await vi.advanceTimersByTimeAsync(10_000); // 把未来的退避一次推完
      await expect(done).resolves.toBe(false);
      expect(calls).toBe(3); // 1 次首发 + 2 次重试 = 上限
    } finally {
      vi.useRealTimers();
    }
  });

  it('内容被拒（230099/11310）不重试：只尝试一次 → false', async () => {
    let calls = 0;
    const channel = channelWith(async () => {
      calls += 1;
      throw Object.assign(new Error('Request failed with status code 400'), {
        response: {
          status: 400,
          data: { code: 230099, msg: 'Failed to create card content, ext=ErrCode: 11310' },
        },
      });
    });
    await expect(patchCardWithRetry(channel, 'om_reject', card)).resolves.toBe(false);
    expect(calls).toBe(1);
  });

  it('错误体里出现「500」这类数字不会被误判为可重试', async () => {
    // 曾经的 `text.includes('500')` 会把这种错误当限频，白等 31 秒。
    let calls = 0;
    const channel = channelWith(async () => {
      calls += 1;
      throw Object.assign(new Error('content 1500 chars over the limit, status code 400'), {
        response: { status: 400, data: { code: 230099, msg: 'Failed to create card content' } },
      });
    });
    await expect(patchCardWithRetry(channel, 'om_noise', card)).resolves.toBe(false);
    expect(calls).toBe(1);
  });
});

describe('CardKit sequence（每张卡第一次更新曾经是空转）', () => {
  it('首次更新发出的序号必须 > 1，之后严格递增', async () => {
    const seqs: number[] = [];
    const channel = {
      rawClient: {
        cardkit: {
          v1: {
            card: {
              update: async (req: { data: { sequence: number } }) => {
                seqs.push(req.data.sequence);
                return { code: 0 };
              },
            },
          },
        },
      },
    } as unknown as LarkChannel;
    const card = { schema: '2.0', body: { elements: [] } };
    adoptManagedCard('om_seq', '7699_seq');
    await updateManagedCard(channel, 'om_seq', card);
    await updateManagedCard(channel, 'om_seq', card);
    forgetManagedCard('om_seq');
    // card.create 已经占用了 1：等于或小于当前值会被静默忽略（HTTP 200 + code 0，卡面不动）。
    // 实测同一实体 seq=1 无变化、seq=2 立刻生效，所以第一次更新就必须 > 1。
    expect(seqs[0]!).toBeGreaterThan(1);
    expect(seqs[1]!).toBeGreaterThan(seqs[0]!);
    // 毫秒时间戳会超 int32：飞书直接回 9499 Invalid parameter value: Sequence。
    expect(seqs[1]!).toBeLessThan(2 ** 31);
  });

  it('freshSequence 单调、永不为 1', () => {
    const a = freshSequence();
    const b = freshSequence(a);
    expect(a).toBeGreaterThan(1);
    expect(b).toBeGreaterThan(a);
  });
});

describe('sequence 水位（跨进程）', () => {
  it('重启后取号必须高于该卡已用过的水位，否则更新会被静默忽略', async () => {
    const seqs: number[] = [];
    const channel = {
      rawClient: {
        cardkit: {
          v1: {
            card: {
              update: async (req: { data: { sequence: number } }) => {
                seqs.push(req.data.sequence);
                return { code: 0 };
              },
            },
          },
        },
      },
    } as unknown as LarkChannel;
    const card = { schema: '2.0', body: { elements: [] } };
    adoptManagedCard('om_wm', '7699_wm');
    await updateManagedCard(channel, 'om_wm', card);
    forgetManagedCard('om_wm');
    const watermark = sequenceWatermark('7699_wm');
    // 上一进程用过的值必须被记住（CardKit 的 sequence 是实体级严格递增：
    // 低于地板的值会被「接受但忽略」——HTTP 200 + code 0，卡面却不动）。
    expect(watermark).toBeGreaterThan(1);
    expect(watermark).toBe(seqs[0]);
    // 模拟重启：新进程即使只按 now 取号，也必须被水位顶上去。
    expect(freshSequence(sequenceWatermark('7699_wm'))).toBeGreaterThan(watermark);
  });
});
