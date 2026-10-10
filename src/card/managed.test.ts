import { describe, expect, it } from 'vitest';
import { stripRunningState } from './managed';

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
  });

  it('survives a card with no body', () => {
    const out = JSON.stringify(stripRunningState({}));
    expect(out).toContain('以上为已输出的部分内容');
  });
});
