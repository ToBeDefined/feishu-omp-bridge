import { describe, expect, it } from 'vitest';
import { renderDiffBody } from './diff';

describe('renderDiffBody', () => {
  it('renders the cwd, stat summary and diff body', () => {
    const out = renderDiffBody('/repo', 'file.ts | 2 +-', '- old\n+ new');
    expect(out).toContain('/repo');
    expect(out).toContain('file.ts | 2 +-');
    expect(out).toContain('- old');
    expect(out).toContain('+ new');
    expect(out).toContain('```diff');
  });

  it('omits the stat block when empty', () => {
    const out = renderDiffBody('/repo', '', '+ new');
    expect(out).not.toContain('file.ts');
    expect(out).toContain('+ new');
  });

  it('caps an oversized diff with a truncation marker', () => {
    const out = renderDiffBody('/repo', '', 'x'.repeat(9000));
    expect(out).toContain('diff 已截断');
    expect(out.length).toBeLessThan(9000);
  });
});
