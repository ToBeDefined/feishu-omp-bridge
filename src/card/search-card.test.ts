import { describe, expect, it } from 'vitest';
import {
  excerptAround,
  renderSearchContext,
  renderSearchGroups,
  SEARCH_COMPACT_GROUPS,
  searchDetailCard,
  searchDetailText,
  searchEmptyCard,
  searchResultsCard,
  type SearchContext,
} from './search-card';

function sampleContext(over: Partial<SearchContext> = {}): SearchContext {
  const messages = over.messages ?? [{ role: 'user' as const, content: '问题' }];
  return {
    sessionId: 'sess-1',
    workspace: '~/repo',
    title: '标题',
    matchCount: 1,
    groups: [{ segmentId: 'sess-1', messages, hitIndex: 0, matchCount: over.matchCount ?? 1 }],
    messages,
    hitIndex: 0,
    ...over,
  };
}

/** Every markdown element content string (descending into column rows), for
 * layout assertions. */
function markdowns(card: object): string[] {
  type El = { tag: string; content?: string; columns?: Array<{ elements: El[] }> };
  const out: string[] = [];
  const walk = (els: El[]): void => {
    for (const e of els) {
      if (e.tag === 'markdown') out.push(e.content ?? '');
      for (const col of e.columns ?? []) walk(col.elements);
    }
  };
  walk((card as { body: { elements: El[] } }).body.elements);
  return out;
}

describe('excerptAround', () => {
  it('centres the snippet on the keyword instead of showing the head', () => {
    const text = `${'前言 '.repeat(200)}目标词出现在很后面。`;
    const out = excerptAround(text, '目标词', 60);
    expect(out).toContain('目标词');
    expect(out.startsWith('…')).toBe(true);
    expect(out.length).toBeLessThanOrEqual(62);
  });

  it('marks both trimmed sides when the hit sits mid-message', () => {
    const out = excerptAround(`${'a'.repeat(100)}kw${'b'.repeat(100)}`, 'kw', 60);
    // 60-char body: 20 chars of lead-in, the hit, then the rest of the budget.
    expect(out).toBe(`…${'a'.repeat(20)}kw${'b'.repeat(38)}…`);
  });

  it('falls back to the head with a trailing ellipsis when there is no hit', () => {
    expect(excerptAround('x'.repeat(200), 'nope', 50)).toBe(`${'x'.repeat(50)}…`);
    expect(excerptAround('x'.repeat(200), undefined, 50)).toBe(`${'x'.repeat(50)}…`);
  });

  it('returns short text untouched, whitespace collapsed', () => {
    expect(excerptAround('  a\n\n  b  ', 'a', 50)).toBe('a b');
  });
});

describe('renderSearchContext', () => {
  it('matches the keyword case-insensitively and bolds it', () => {
    const out = renderSearchContext(
      { messages: [{ role: 'user', content: 'KW 出现在句首，句中也有 kw。' }], hitIndex: 0 },
      'compact',
      'kw',
    );
    expect(out).toContain('**KW**');
    expect(out).toContain('**kw**');
  });

  it('treats regex metacharacters in the keyword literally', () => {
    // `/search 1.5` used to bold every "1x5" and `/search a|b` bolded a bare "a".
    const dotted = renderSearchContext(
      { messages: [{ role: 'user', content: '版本 125 与 1.5 都提到了' }], hitIndex: 0 },
      'compact',
      '1.5',
    );
    expect(dotted).toContain('**1.5**');
    expect(dotted).not.toContain('**125**');

    const piped = renderSearchContext(
      { messages: [{ role: 'user', content: 'a 和 a|b 都在这里' }], hitIndex: 0 },
      'compact',
      'a|b',
    );
    expect(piped).toContain('**a\\|b**'.replace('\\|', '|'));
    expect(piped).not.toContain('**a** 和');
  });

  it('leaves text untouched without a keyword', () => {
    const out = renderSearchContext(
      { messages: [{ role: 'user', content: '普通一句话' }], hitIndex: 0 },
      'compact',
    );
    expect(out).toContain('普通一句话');
    expect(out).not.toContain('**普通');
  });

  it('renders a compact pair as two lines with the hit marked', () => {
    const out = renderSearchContext(
      {
        messages: [
          { role: 'user', content: '问题' },
          { role: 'assistant', content: '回答' },
        ],
        hitIndex: 1,
      },
      'compact',
    );
    expect(out.split('\n')).toEqual(['🧑 问题', '📍🤖 回答']);
  });

  it('keeps the detail view as labelled block quotes', () => {
    const out = renderSearchContext(
      {
        messages: [
          { role: 'user', content: '问题' },
          { role: 'assistant', content: '回答' },
        ],
        hitIndex: 0,
      },
      'detail',
    );
    expect(out).toContain('📍🧑 **你**\n> 问题');
    expect(out).toContain('🤖 **助手**\n> 回答');
  });

  it('escapes a leading > / # so it cannot nest quotes or become a heading', () => {
    const out = renderSearchContext(
      { messages: [{ role: 'user', content: '# 大标题\n> 引用行' }], hitIndex: 0 },
      'detail',
    );
    expect(out).toContain('> \\# 大标题');
    expect(out).toContain('> \\> 引用行');
    expect(out).not.toContain('\n> > 引用行');
  });
});

describe('renderSearchGroups', () => {
  const pair = (text: string) => ({
    messages: [{ role: 'user' as const, content: text }],
    hitIndex: 0,
    matchCount: 1,
  });

  it('leaves a single matched pair unlabelled', () => {
    expect(renderSearchGroups({ groups: [pair('只有一处')] }, 'detail')).toContain('只有一处');
    expect(renderSearchGroups({ groups: [pair('只有一处')] }, 'detail')).not.toContain('第 1 处');
  });

  it('labels every pair when a conversation matched several times', () => {
    const out = renderSearchGroups({ groups: [pair('最新一处'), pair('更早一处')] }, 'detail');
    expect(out).toContain('**第 1 处**\n');
    expect(out).toContain('**第 2 处**\n');
    // Newest first: group order is preserved, not re-sorted.
    expect(out.indexOf('最新一处')).toBeLessThan(out.indexOf('更早一处'));
  });
});

describe('searchResultsCard', () => {
  it('keeps only the card title heading-sized', () => {
    const card = searchResultsCard('foo', [sampleContext()], 'q1');
    const json = JSON.stringify(card);
    expect(json.match(/"text_size":"heading"/g)).toHaveLength(1);
    const lines = markdowns(card);
    expect(lines[0]).toContain('搜索');
    expect(lines[1]).toContain('找到 1 个对话');
    expect(lines[1]).toContain('1 处匹配');
    // Row identity is an ordinary-size line, with the meta below it.
    expect(lines[2]).toBe('**#1** · 🏷 **标题**');
    expect(lines[3]).toContain('📁 ~/repo');
    expect(lines[3]).toContain('🆔 sess-1');
    expect(lines[3]).not.toContain('🏷');
  });

  it('never puts a 36-char session id in the row identity line', () => {
    const UUID = '019f9432-b808-7000-8bf4-073defc52637';
    const card = searchResultsCard('kw', [sampleContext({ sessionId: UUID })], 'q1');
    const lines = markdowns(card);
    expect(lines[2]).not.toContain(UUID);
    expect(lines[3]).toContain('🆔 019f9432…');
    // The full id is only in the detail view.
    expect(searchDetailText({ sessionId: UUID, groups: [] })).toContain(UUID);
  });

  it('lays each row out as content + actions columns', () => {
    const card = searchResultsCard('foo', [sampleContext()], 'q1') as {
      body: { elements: Array<Record<string, unknown>> };
    };
    const row = card.body.elements.find((e) => e.tag === 'column_set') as {
      flex_mode: string;
      columns: Array<{ width: string; elements: Array<Record<string, unknown>> }>;
    };
    expect(row.flex_mode).toBe('none');
    expect(row.columns.map((c) => c.width)).toEqual(['weighted', 'auto']);
    const buttons = row.columns[1]!.elements.map(
      (e) => (e.text as { content: string }).content,
    );
    expect(buttons).toEqual(['继续对话', '详情']);
  });

  it('caps snippets per row and points at 详情 for the rest', () => {
    const groups = Array.from({ length: 4 }, (_, i) => ({
      messages: [{ role: 'user' as const, content: `第 ${i + 1} 处命中` }],
      hitIndex: 0,
      matchCount: 1,
    }));
    const card = JSON.stringify(
      searchResultsCard('命中', [sampleContext({ groups, matchCount: 4 })], 'q1'),
    );
    // The keyword itself is bolded inside the snippet, so assert on the label.
    expect(card).toContain('第 1 处');
    expect(card).toContain(`第 ${SEARCH_COMPACT_GROUPS} 处`);
    expect(card).not.toContain(`第 ${SEARCH_COMPACT_GROUPS + 1} 处`);
    expect(card).toContain(`另有 ${4 - SEARCH_COMPACT_GROUPS} 处匹配，点「详情」看全部`);
  });

  it('shows buttons when not done, hides them when done', () => {
    const active = JSON.stringify(searchResultsCard('foo', [sampleContext()], 'q1', true));
    expect(active).toContain('继续对话');
    expect(active).toContain('详情');
    expect(active).toContain('"arg":"q1 1"');

    const done = JSON.stringify(searchResultsCard('foo', [sampleContext()], 'q1', false));
    expect(done).not.toContain('查看详情');
    expect(done).not.toContain('继续对话');
    expect(done).not.toContain('column_set');
    expect(done).toContain('✅ **搜索完成**');
    expect(done).toContain('1 个对话 · 1 处匹配');
  });

  it('shows a match count when a session has multiple hits', () => {
    const card = searchResultsCard('foo', [sampleContext({ matchCount: 3 })], 'q1', true);
    expect(JSON.stringify(card)).toContain('🔎 3 处匹配');
  });

  it('shows relative time and pagination in the results card', () => {
    const contexts = Array.from({ length: 8 }, (_, i) => ({
      ...sampleContext({ sessionId: `s${i}` }),
      messages: [
        {
          role: 'user' as const,
          content: `问题 ${i}`,
          timestamp: new Date(Date.now() - (i + 1) * 3_600_000).toISOString(),
        },
      ],
    }));
    const page1 = JSON.stringify(searchResultsCard('kw', contexts, 'q9', true, 0));
    expect(page1).toContain('第 1-6 个');
    expect(page1).toContain('下一页（剩 2）');
    expect(page1).not.toContain('上一页');
    expect(page1).toContain('"arg":"q9 6"');
    expect(page1).toContain('小时前');
    expect(page1).toContain('**#6**');
    expect(page1).not.toContain('**#7**');

    const page2 = JSON.stringify(searchResultsCard('kw', contexts, 'q9', true, 6));
    expect(page2).toContain('第 7-8 个');
    expect(page2).toContain('上一页');
    expect(page2).toContain('"arg":"q9 0"');
    expect(page2).toContain('**#7**');
    expect(page2).toContain('**#8**');
  });

  it('pages its row numbering off the page offset', () => {
    const many = Array.from({ length: 8 }, (_, i) => sampleContext({ sessionId: `s${i}` }));
    // The 详情 payload must carry the GLOBAL row number, not the page-local one.
    expect(JSON.stringify(searchResultsCard('kw', many, 'q9', true, 6))).toContain('"arg":"q9 7"');
  });

  it('renders every row in the done (settled) view', () => {
    const many = Array.from({ length: 8 }, (_, i) => sampleContext({ sessionId: `s${i}` }));
    const done = JSON.stringify(searchResultsCard('foo', many, 'q1', false));
    expect(done).toContain('**#8**');
    expect(done).toContain('8 个对话');
  });

  it('never advertises a segment count (one session = one conversation)', () => {
    const card = JSON.stringify(
      searchResultsCard('foo', [sampleContext({ segmentCount: 3, matchCount: 4 })], 'q1', true),
    );
    expect(card).not.toContain('🧵');
    expect(card).not.toContain('段');
    expect(card).toContain('🔎 4 处匹配');
  });

  it('renders a topic fallback when the conversation is unnamed', () => {
    const card = JSON.stringify(
      searchResultsCard('foo', [sampleContext({ title: undefined, topic: '看下 FC1 在做什么' })], 'q1', true),
    );
    expect(card).toContain('**#1** · **看下 FC1 在做什么**');
    expect(card).not.toContain('🏷');
    expect(card).not.toContain('_未命名会话_');
  });

  it('marks an unnamed, topic-less row instead of inventing an identity', () => {
    const card = JSON.stringify(
      searchResultsCard('foo', [sampleContext({ title: undefined, topic: undefined })], 'q1'),
    );
    expect(card).toContain('**#1** · _未命名会话_');
  });

  it('renders the empty-hit card', () => {
    const out = JSON.stringify(searchEmptyCard('foo'));
    expect(out).toContain('没有找到包含');
    expect(out).toContain('foo');
  });
});

describe('searchDetailCard', () => {
  it('keeps number / workspace / full session id in the header', () => {
    const done = searchDetailCard({
      sessionId: 'sess-9',
      workspace: '~/ws',
      index: 3,
      matchCount: 2,
      groups: [{ messages: [{ role: 'user', content: '内容' }], hitIndex: 0, matchCount: 1 }],
      done: true,
    });
    const json = JSON.stringify(done);
    expect(json).toContain('✅ **搜索结果 #3**');
    expect(json).toContain('📁 ~/ws');
    expect(json).toContain('🔎 2 处匹配');
    expect(json).toContain('🆔 sess-9');
    expect(json).toContain('内容');
    expect(json).not.toContain('继续对话');
    expect(json).not.toContain('完成');
  });

  it('renders action buttons with the query ref when not done', () => {
    const active = JSON.stringify(
      searchDetailCard({
        sessionId: 'sess-9',
        index: 3,
        groups: [{ messages: [{ role: 'user', content: '内容' }], hitIndex: 0, matchCount: 1 }],
        queryRef: 'q1 3',
      }),
    );
    expect(active).toContain('📄 **搜索结果 #3**');
    expect(active).toContain('继续对话');
    expect(active).toContain('完成');
    expect(active).toContain('q1 3');
    expect(active).not.toContain('✅');
  });

  it('highlights and centres on the keyword in the detail body', () => {
    const card = JSON.stringify(
      searchDetailCard({
        sessionId: 'sess-9',
        groups: [
          {
            messages: [{ role: 'assistant' as const, content: `${'铺垫 '.repeat(500)}关键命中。` }],
            hitIndex: 0,
            matchCount: 1,
          },
        ],
        keyword: '关键命中',
        done: true,
      }),
    );
    expect(card).toContain('**关键命中**');
    expect(card).toContain('…');
  });

  it('renders the text variant with the session id and every pair', () => {
    const text = searchDetailText({
      sessionId: 'sess-9',
      workspace: '~/ws',
      groups: [
        { messages: [{ role: 'user', content: '一' }], hitIndex: 0, matchCount: 1 },
        { messages: [{ role: 'user', content: '二' }], hitIndex: 0, matchCount: 1 },
      ],
    });
    expect(text).toContain('📁 ~/ws');
    expect(text).toContain('🆔 会话: `sess-9`');
    expect(text).toContain('**第 1 处**');
    expect(text).toContain('**第 2 处**');
  });
});
