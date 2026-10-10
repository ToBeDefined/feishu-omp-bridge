import { describe, expect, it } from 'vitest';
import { diffCard } from '../../card/templates';

describe('diffCard', () => {
  it('renders stat and diff with the cwd label', () => {
    const out = JSON.stringify(diffCard('/repo', 'file.ts | 2 +-', '- old\n+ new'));
    expect(out).toContain('/repo');
    expect(out).toContain('file.ts | 2 +-');
    expect(out).toContain('- old');
    expect(out).toContain('+ new');
    expect(out).toContain('```diff');
  });

  it('omits the stat block when empty', () => {
    const out = JSON.stringify(diffCard('/repo', '', '+ new'));
    expect(out).not.toContain('file.ts');
    expect(out).toContain('+ new');
  });

  it('collapses the diff body and truncates oversized diffs', () => {
    const out = JSON.stringify(diffCard('/repo', '', 'x'.repeat(9000)));
    // 折叠面板默认收起；9000 字符触发截断提示，只保留前 4000 字符。
    expect(out).toContain('"expanded":false');
    expect(out).toContain('diff 已截断');
    expect(out).not.toContain('x'.repeat(4001));
  });
});
