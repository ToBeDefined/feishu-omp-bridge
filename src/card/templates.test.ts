import { describe, expect, it } from 'vitest';
import { statusCard } from './templates';
import { resumeCard, type ResumeOption } from './model-card';

describe('statusCard', () => {
  it('shows the session title when set', () => {
    const withTitle = JSON.stringify(statusCard({
      cwd: '/repo',
      sessionId: 's1',
      sessionTitle: '修搜索',
      sessionStale: false,
      agentName: 'omp',
      scope: 'oc_1',
      chatMode: 'p2p',
    }));
    expect(withTitle).toContain('修搜索');

    const without = JSON.stringify(statusCard({
      cwd: '/repo',
      sessionId: 's1',
      sessionStale: false,
      agentName: 'omp',
      scope: 'oc_1',
      chatMode: 'p2p',
    }));
    expect(without).not.toContain('标题');
  });
});

describe('resumeCard', () => {
  it('shows the title ahead of the summary', () => {
    const sessions: ResumeOption[] = [
      { sessionId: 's1', cwd: '/repo', timestamp: 't', title: '已命名', summary: '旧摘要' },
      { sessionId: 's2', cwd: '/repo2', timestamp: 't2', summary: '摘要B' },
    ];
    const out = JSON.stringify(resumeCard('s1', sessions));

    // Titled session shows its title; the untitled one shows no title marker.
    expect(out).toContain('🏷 **已命名**');
    expect(out).toContain('摘要B');
    // Exactly one titled row — s2 stays unlabeled.
    expect((out.match(/🏷/g) ?? []).length).toBe(1);
  });
});
