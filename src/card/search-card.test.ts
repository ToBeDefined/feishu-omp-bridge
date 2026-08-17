import { describe, expect, it } from 'vitest';
import type { CommandContext } from '../commands';
import {
  renderSearchContext,
  searchDetailCard,
  searchResultsCard,
  workspaceLabel,
  type SearchContext,
} from './search-card';

function ctxFor(workspaces: Record<string, string> = {}): CommandContext {
  return {
    workspaces: { listNamed: () => workspaces },
  } as unknown as CommandContext;
}

function sampleContext(over: Partial<SearchContext> = {}): SearchContext {
  return {
    messages: [{ role: 'user', content: '问题' }],
    hitIndex: 0,
    sessionId: 'sess-1',
    workspace: '~/repo',
    title: '标题',
    ...over,
  };
}

describe('renderSearchContext', () => {
  it('marks the hit with 📍', () => {
    const out = renderSearchContext({
      messages: [{ role: 'user', content: 'a' }, { role: 'assistant', content: 'b' }],
      hitIndex: 1,
    });
    expect(out).toContain('📍');
    expect(out.indexOf('📍') > out.indexOf('🧑')).toBe(true);
  });

  it('labels user vs assistant roles', () => {
    const out = renderSearchContext({
      messages: [
        { role: 'user', content: 'hi' },
        { role: 'assistant', content: 'yo' },
      ],
      hitIndex: 0,
    });
    expect(out).toContain('🧑 **你**');
    expect(out).toContain('🤖 **助手**');
  });

  it('escapes a leading > to avoid quote nesting inside the blockquote', () => {
    const out = renderSearchContext({
      messages: [{ role: 'user', content: '> 嵌套引用' }],
      hitIndex: 0,
    });
    expect(out).toContain('\\> 嵌套引用');
  });
});

describe('workspaceLabel', () => {
  it('returns the named workspace when cwd matches', () => {
    const ctx = ctxFor({ bridge: '/Users/tbd/bridge' });
    expect(workspaceLabel(ctx, '/Users/tbd/bridge')).toBe('bridge');
  });

  it('returns raw cwd when no named workspace matches', () => {
    const ctx = ctxFor({ other: '/tmp/x' });
    expect(workspaceLabel(ctx, '/Users/tbd/code')).toBe('/Users/tbd/code');
  });
});

describe('searchResultsCard', () => {
  it('includes title / workspace / session meta in heading', () => {
    const card = searchResultsCard('foo', [sampleContext()], 'q1', true);
    const body = JSON.stringify(card);
    expect(body).toContain('🏷 标题');
    expect(body).toContain('📁 ~/repo');
    expect(body).toContain('🆔 sess-1');
  });

  it('shows buttons when not done, hides them when done', () => {
    const active = JSON.stringify(searchResultsCard('foo', [sampleContext()], 'q1', true));
    expect(active).toContain('查看详情');
    expect(active).toContain('继续对话');

    const done = JSON.stringify(searchResultsCard('foo', [sampleContext()], 'q1', false));
    // Buttons gone in done state; header becomes the ✅ summary line.
    expect(done).not.toContain('查看详情');
    expect(done).not.toContain('继续对话');
    expect(done).toContain('✅ 搜索完成');
  });

  it('caps list at 6 with a hint line', () => {
    const many = Array.from({ length: 8 }, (_, i) => sampleContext({ sessionId: `s${i}` }));
    const card = searchResultsCard('foo', many, 'q1', true);
    const body = JSON.stringify(card);
    expect(body).toContain('仅显示最近 6 个片段');
    // 8 items → 6 rendered headings (#1..#6); #7 not a heading
    expect(body).toContain('"content":"#6 ·');
    expect(body).not.toContain('"content":"#7 ·');
  });

  it('renders all items in the done (settled) view', () => {
    const many = Array.from({ length: 8 }, (_, i) => sampleContext({ sessionId: `s${i}` }));
    const done = JSON.stringify(searchResultsCard('foo', many, 'q1', false));
    expect(done).toContain('"content":"#8 ·');
  });
});

describe('searchDetailCard', () => {
  it('keeps number / workspace / session in the done header', () => {
    const done = JSON.stringify(
      searchDetailCard('sess-9', 'content', undefined, 3, true, '~/ws'),
    );
    expect(done).toContain('✅ 搜索结果 #3');
    expect(done).toContain('📁 ~/ws');
    expect(done).toContain('🆔 sess-9');
    expect(done).not.toContain('继续对话');
    expect(done).not.toContain('完成');
  });

  it('renders action buttons with query ref when not done', () => {
    const active = JSON.stringify(
      searchDetailCard('sess-9', 'content', 'q1 3', 3, false, '~/ws'),
    );
    expect(active).toContain('继续对话');
    expect(active).toContain('完成');
    expect(active).toContain('q1 3');
  });
});
