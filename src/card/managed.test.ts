import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { finalizeByKind, finalizeInterruptedCards, stripRunningState, type RunningCardKind } from './managed';
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
  });

  it('survives a card with no body', () => {
    const out = JSON.stringify(stripRunningState({}));
    expect(out).toContain('以上为已输出的部分内容');
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

  it('preserves a streaming card snapshot with the interruption note', () => {
    const out = JSON.stringify(
      finalizeByKind('stream', {
        schema: '2.0',
        body: { elements: [{ tag: 'markdown', content: '已输出内容' }] },
      }),
    );
    expect(out).toContain('已输出内容');
    expect(out).toContain('以上为已输出的部分内容');
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
});
