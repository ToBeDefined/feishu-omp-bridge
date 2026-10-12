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
  type SearchHitGroup,
} from './search-card';
import { historyCard } from './history-card';

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

  /** Every grey block of a card: background, padding and its first content line. */
function greyBlocks(card: object): Array<{ padding?: string; content: string }> {
    const els = (card as { body: { elements: Array<Record<string, unknown>> } }).body.elements;
    return els
      .filter(
        (e) =>
          e.tag === 'column_set' &&
          (e.columns as Array<{ background_style?: string }>)[0]?.background_style === 'grey',
      )
      .map((e) => {
        const col = (e.columns as Array<{ padding?: string; elements: Array<{ content?: string }> }>)[0]!;
        return { padding: col.padding, content: col.elements[0]?.content ?? '' };
      });
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

/** Every button label (descending into column rows), for pager-copy assertions. */
function buttonLabels(card: object): string[] {
  type El = { tag: string; text?: { content?: string }; columns?: Array<{ elements: El[] }> };
  const out: string[] = [];
  const walk = (els: El[]): void => {
    for (const e of els) {
      if (e.tag === 'button') out.push(e.text?.content ?? '');
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

  it('marks the row of the conversation the user is already in', () => {
    const contexts = [
      sampleContext({ sessionId: 'sess-current', title: '当前这条' }),
      sampleContext({ sessionId: 'sess-other', title: '另一条' }),
    ];
    const lines = markdowns(
      searchResultsCard('foo', contexts, 'q1', 0, { currentSessionId: 'sess-current' }),
    );
    // 标记紧跟行号（埋在 meta 里就没人看得见），另一行不受影响。
    expect(lines.filter((l) => l.startsWith('**#'))).toEqual([
      '**#1** ✅ 当前 · 🏷 **当前这条**',
      '**#2** · 🏷 **另一条**',
    ]);
    // 当前对话不给「继续对话」（恢复它等于原地重启），只留「详情」。
    const json = JSON.stringify(
      searchResultsCard('foo', contexts, 'q1', 0, { currentSessionId: 'sess-current' }),
    );
    expect(json.match(/"text":"\{?"?继续对话/g) ?? json.match(/继续对话/g)).toHaveLength(1);
    expect(json.match(/详情/g)).toHaveLength(2);
    // 没传 currentSessionId 时一行都不标。
    const plain = JSON.stringify(searchResultsCard('foo', contexts, 'q1'));
    expect(plain).not.toContain('✅ 当前');
    expect(plain.match(/继续对话/g)).toHaveLength(2);
  });

  it('stacks identity → meta → block → buttons, with the buttons side by side', () => {
    const card = searchResultsCard('foo', [sampleContext()], 'q1') as {
      body: { elements: Array<Record<string, unknown>> };
    };
    const kinds = card.body.elements.map((e) => {
      if (e.tag === 'hr') return 'hr';
      if (e.tag === 'markdown') return 'md';
      const grey =
        (e.columns as Array<{ background_style?: string }>)[0]?.background_style === 'grey';
      return grey ? 'grey-block' : 'button-row';
    });
    // 表头(md×2) → hr → 身份 → meta → 灰块 → 本行按钮（单页没有分页行）
    expect(kinds).toEqual(['md', 'md', 'hr', 'md', 'md', 'grey-block', 'button-row']);
    // 按钮在整行最底下：身份与 meta 都是普通 markdown，不在按钮列里。
    expect(card.body.elements[3]).toMatchObject({ tag: 'markdown', content: '**#1** · 🏷 **标题**' });

    const row = card.body.elements.filter((e) => e.tag === 'column_set').at(-1) as {
      flex_mode: string;
      columns: Array<{ width: string; weight: number; elements: Array<Record<string, unknown>> }>;
    };
    expect(row.flex_mode).toBe('none');
    expect(row.columns.map((c) => [c.width, c.weight])).toEqual([
      ['weighted', 1],
      ['weighted', 1],
    ]);
    expect(row.columns.map((c) => (c.elements[0] as { text: { content: string } }).text.content)).toEqual([
      '继续对话',
      '详情',
    ]);
  });

  it('gives each matched pair its own grey block, labelled when there are several', () => {
    const two = sampleContext({
      matchCount: 2,
      groups: [
        { messages: [{ role: 'user', content: '新的一处' }], hitIndex: 0, matchCount: 1 },
        { messages: [{ role: 'user', content: '更早一处' }], hitIndex: 0, matchCount: 1 },
      ],
    });
    const card = searchResultsCard('foo', [two], 'q1');
    const blocks = greyBlocks(card);
    expect(blocks).toHaveLength(2);
    expect(blocks.every((b) => b.padding === '8px')).toBe(true);
    expect(blocks[0]!.content).toContain('新的一处');
    expect(blocks[1]!.content).toContain('更早一处');
    // 灰块里只有命中内容：meta（工作区 / id）留在块外的小灰字行。
    expect(blocks[0]!.content).not.toContain('🆔');
    expect(markdowns(card).filter((c) => c.startsWith('**第 '))).toEqual(['**第 1 处**', '**第 2 处**']);
    // 单处命中不加标签。
    const single = markdowns(searchResultsCard('foo', [sampleContext()], 'q1'));
    expect(single.some((c) => c.startsWith('**第 '))).toBe(false);
    expect(greyBlocks(searchResultsCard('foo', [sampleContext()], 'q1'))).toHaveLength(1);
  });

  it('keeps the 另有 N 处 hint outside the block, as a meta line', () => {
    const groups = Array.from({ length: 4 }, (_, i) => ({
      messages: [{ role: 'user' as const, content: `第 ${i + 1} 处命中` }],
      hitIndex: 0,
      matchCount: 1,
    }));
    const card = searchResultsCard('foo', [sampleContext({ groups, matchCount: 4 })], 'q1');
    const hint = markdowns(card).find((c) => c.includes('另有'));
    expect(hint).toContain('另有 2 处匹配，点「详情」看全部');
    expect(greyBlocks(card).some((b) => b.content.includes('另有'))).toBe(false);
  });

  it('divides every row boundary, plus the header and the pager', () => {
    const many = Array.from({ length: 3 }, (_, i) => sampleContext({ sessionId: `s${i}` }));
    const card = searchResultsCard('foo', many, 'q1') as {
      body: { elements: Array<Record<string, unknown>> };
    };
    // 3 条一页放得下 → 表头后 1 条 + 行间 2 条，没有分页行也就没有分页前那条。
    expect(card.body.elements.filter((e) => e.tag === 'hr')).toHaveLength(3);
    expect(card.body.elements.at(-1)!.tag).toBe('column_set');
    // 需要分页时：行间 2 条 + 分页前 1 条（分页行在最后）。
    const paged = searchResultsCard('foo', Array.from({ length: 8 }, (_, i) => sampleContext({ sessionId: `s${i}` })), 'q1') as {
      body: { elements: Array<Record<string, unknown>> };
    };
    expect(paged.body.elements.filter((e) => e.tag === 'hr')).toHaveLength(1 + 5 + 1);
    expect(paged.body.elements.at(-2)!.tag).toBe('hr');
    expect(paged.body.elements.at(-1)!.tag).toBe('column_set');
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

  it('renders row actions always, and a pager only when there is another page', () => {
    const single = JSON.stringify(searchResultsCard('foo', [sampleContext()], 'q1'));
    expect(single).toContain('继续对话');
    expect(single).toContain('详情');
    expect(single).toContain('"arg":"q1 1 0"');
    // 只有一页 → 没有分页行，也没有尾随的分隔线。
    expect(single).not.toContain('上一页');
    expect(single).not.toContain('下一页');

    const many = Array.from({ length: 8 }, (_, i) => sampleContext({ sessionId: `s${i}` }));
    const paged = JSON.stringify(searchResultsCard('foo', many, 'q1'));
    expect(paged).toContain('下一页（剩 2）');
    expect(paged).not.toContain('上一页');   // 第 1 页没有上一页
  });

  it('shows a match count when a session has multiple hits', () => {
    const card = searchResultsCard('foo', [sampleContext({ matchCount: 3 })], 'q1');
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
    const page1 = JSON.stringify(searchResultsCard('kw', contexts, 'q9', 0));
    expect(page1).toContain('第 1-6 个');
    expect(page1).toContain('下一页（剩 2）');
    expect(page1).not.toContain('上一页');
    expect(page1).toContain('"arg":"q9 6"');
    expect(page1).toContain('小时前');
    expect(page1).toContain('**#6**');
    expect(page1).not.toContain('**#7**');

    const page2 = JSON.stringify(searchResultsCard('kw', contexts, 'q9', 6));
    expect(page2).toContain('第 7-8 个');
    expect(page2).toContain('上一页');
    expect(page2).toContain('"arg":"q9 0"');
    expect(page2).toContain('**#7**');
    expect(page2).toContain('**#8**');
  });

  it('lays the pager out side by side, giving the longer label more room', () => {
    // 14 条、第 2 页：既有上一页也有下一页，才会出现三键并排。
    const contexts = Array.from({ length: 14 }, (_, i) => sampleContext({ sessionId: `s${i}` }));
    const card = searchResultsCard('kw', contexts, 'q9', 6) as {
      body: { elements: Array<Record<string, unknown>> };
    };
    // 最后一个是分页行：三键横排（不是「每键占满一行」的 actions）。
    const pager = card.body.elements.at(-1) as {
      tag: string;
      flex_mode: string;
      columns: Array<{ weight: number; elements: Array<{ text: { content: string } }> }>;
    };
    expect(pager.tag).toBe('column_set');
    expect(pager.flex_mode).toBe('none');
    expect(pager.columns.map((c) => c.elements[0]!.text.content)).toEqual([
      '↑ 上一页',
      '↓ 下一页（剩 2）',
    ]);
    // 长标签多分宽度，短标签保持 1：等宽会让「下一页（剩 N）」在手机上折行。
    expect(pager.columns.map((c) => c.weight)).toEqual([1, 1.6]);
  });

  it('pages its row numbering off the page offset', () => {
    const many = Array.from({ length: 8 }, (_, i) => sampleContext({ sessionId: `s${i}` }));
    // The 详情 payload must carry the GLOBAL row number, not the page-local one.
    expect(JSON.stringify(searchResultsCard('kw', many, 'q9', 6))).toContain('"arg":"q9 7 6"');
  });

  it('never advertises a segment count (one session = one conversation)', () => {
    const card = JSON.stringify(
      searchResultsCard('foo', [sampleContext({ segmentCount: 3, matchCount: 4 })], 'q1'),
    );
    expect(card).not.toContain('🧵');
    expect(card).not.toContain('段');
    expect(card).toContain('🔎 4 处匹配');
  });

  it('renders a topic fallback when the conversation is unnamed', () => {
    const card = JSON.stringify(
      searchResultsCard('foo', [sampleContext({ title: undefined, topic: '看下 FC1 在做什么' })], 'q1'),
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

  it('gives the empty card a real, executable next step (no dead end)', () => {
    const card = JSON.stringify(searchEmptyCard('foo'));
    // 不是死胡同：一个真能点的动作，重跑同一次检索。
    expect(card).toContain('重新搜索');
    expect(card).toContain('"cmd":"search.do"');
    expect(card).toContain('"arg":"foo"');
  });
});

describe('searchDetailCard', () => {
  it('keeps number / workspace / full session id in the header', () => {
    const card = searchDetailCard({
      sessionId: 'sess-9',
      workspace: '~/ws',
      index: 3,
      matchCount: 2,
      groups: [{ messages: [{ role: 'user', content: '内容' }], hitIndex: 0, matchCount: 1 }],
    });
    const json = JSON.stringify(card);
    expect(json).toContain('📄 **搜索结果 #3**');
    expect(json).toContain('📁 ~/ws');
    expect(json).toContain('🔎 2 处匹配');
    expect(json).toContain('🆔 sess-9');
    expect(json).toContain('内容');
    // 页脚只有「继续对话」。
    expect(json).toContain('继续对话');
    expect(json).not.toContain('完成');
  });

  it('leaves no pager or 完成 button anywhere on the detail card', () => {
    const active = JSON.stringify(
      searchDetailCard({
        sessionId: 'sess-9',
        index: 3,
        groups: [{ messages: [{ role: 'user', content: '内容' }], hitIndex: 0, matchCount: 1 }],
        queryRef: 'q1 3',
      }),
    );
    expect(active).not.toContain('完成');
    expect(active).not.toContain('上一页');
  });

  it('adds a 返回结果 escape that lands on the same result page', () => {
    const groups = [{ messages: [{ role: 'user' as const, content: '内容' }], hitIndex: 0, matchCount: 1 }];
    // 从第 2 页（offset 6）进入详情 → 返回必须带同一个 offset，坐标与进入时一致。
    const fromPage2 = JSON.stringify(
      searchDetailCard({ sessionId: 'sess-9', index: 7, groups, queryId: 'q1', offset: 6 }),
    );
    expect(fromPage2).toContain('返回结果');
    expect(fromPage2).toContain('"cmd":"search.page"');
    expect(fromPage2).toContain('"arg":"q1 6"');
    expect(fromPage2).toContain('继续对话');
    // 没显式给 offset 时按行号推算所属页（第 1 行 → 第 1 页）。
    const derived = JSON.stringify(
      searchDetailCard({ sessionId: 'sess-9', index: 1, groups, queryId: 'q1' }),
    );
    expect(derived).toContain('"arg":"q1 0"');
    // 当前会话不再给「继续对话」，但「返回结果」这条出路仍在。
    const current = JSON.stringify(
      searchDetailCard({ sessionId: 'sess-9', index: 8, groups, queryId: 'q1', offset: 6, current: true }),
    );
    expect(current).toContain('返回结果');
    expect(current).toContain('"arg":"q1 6"');
    expect(current).not.toContain('继续对话');
  });

  it('renders the footer as one inline action', () => {
    const active = searchDetailCard({
      sessionId: 'sess-9',
      groups: [{ messages: [{ role: 'user', content: '内容' }], hitIndex: 0, matchCount: 1 }],
      queryRef: 'q1 3',
    }) as { body: { elements: Array<Record<string, unknown>> } };
    const footer = active.body.elements.at(-1) as {
      flex_mode: string;
      columns: Array<{ weight: number; elements: Array<{ text: { content: string } }> }>;
    };
    expect(footer.flex_mode).toBe('none');
    expect(footer.columns.map((c) => [c.elements[0]!.text.content, c.weight])).toEqual([
      ['继续对话', 1],
    ]);
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
      }),
    );
    expect(card).toContain('**关键命中**');
    expect(card).toContain('…');
  });

  it('uses the same per-pair grey blocks as the result list', () => {
    const groups: SearchHitGroup[] = [
      { messages: [{ role: 'user', content: '一' }], hitIndex: 0, matchCount: 1 },
      { messages: [{ role: 'user', content: '二' }], hitIndex: 0, matchCount: 1 },
    ];
    const detail = searchDetailCard({ sessionId: 'sess-9', groups });
    const list = searchResultsCard('foo', [sampleContext({ groups, matchCount: 2 })], 'q1');
    // 两张卡同款：同样的块数、同样的「第 k 处」标签。
    const shape = (card: object) => ({
      blocks: greyBlocks(card).length,
      labels: markdowns(card).filter((c) => c.startsWith('**第 ')),
    });
    expect(shape(detail)).toEqual({ blocks: 2, labels: ['**第 1 处**', '**第 2 处**'] });
    expect(shape(list).labels).toEqual(shape(detail).labels);
    expect(shape(list).blocks).toBe(2);
    // 详情卡仍是「全部命中 + 完整正文 + 按钮」。
    expect(JSON.stringify(detail)).toContain('继续对话');
  });

  it('marks the detail card of the current conversation and drops its resume', () => {
    const groups: SearchHitGroup[] = [
      { messages: [{ role: 'user', content: '一' }], hitIndex: 0, matchCount: 1 },
    ];
    const current = searchDetailCard({
      sessionId: 'sess-current',
      workspace: '~/ws',
      index: 2,
      groups,
      queryRef: 'q1 2',
      current: true,
    });
    const json = JSON.stringify(current);
    expect(json).toContain('✅ 当前对话');
    // 当前对话没有任何可执行动作 → 整个页脚（连同它的 hr）都不渲染。
    expect(json).not.toContain('继续对话');
    expect(json).not.toContain('完成');
    const els = (current as { body: { elements: Array<Record<string, unknown>> } }).body.elements;
    expect(els.at(-1)!.tag).toBe('column_set');
    expect(
      (els.at(-1)!.columns as Array<{ background_style?: string }>)[0]!.background_style,
    ).toBe('grey');
    // 纯文本详情同样带标记。
    expect(searchDetailText({ sessionId: 'sess-current', current: true, groups })).toContain(
      '✅ 当前对话',
    );
    // 非当前对话不变。
    const other = JSON.stringify(searchDetailCard({ sessionId: 'sess-9', index: 2, groups, queryRef: 'q1 2' }));
    expect(other).not.toContain('当前对话');
    expect(other).toContain('继续对话');
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

describe('两卡翻页与每页条数', () => {
  it('uses one shared pager copy in /history and /search', () => {
    // 两卡都停在第 2 页且都还剩 2 条：翻页键文案必须逐字相同。
    const searchPaged = searchResultsCard(
      'kw',
      Array.from({ length: 14 }, (_, i) => sampleContext({ sessionId: `s${i}` })),
      'q9',
      6,
    );
    const historyPaged = historyCard(
      Array.from({ length: 18 }, (_, i) => ({
        sessionId: `s${i}`,
        updatedAtMs: Date.now(),
        turns: 1,
        workspace: 'w',
      })),
      { mode: 'all', offset: 8, total: 18 },
    );
    const pagerOf = (card: object) =>
      buttonLabels(card).filter((l) => l.includes('上一页') || l.includes('下一页'));
    expect(pagerOf(searchPaged)).toEqual(['↑ 上一页', '↓ 下一页（剩 2）']);
    expect(pagerOf(historyPaged)).toEqual(pagerOf(searchPaged));
  });

  it('states the page size on both cards so nobody has to count', () => {
    expect(markdowns(searchResultsCard('kw', [sampleContext()], 'q1')).join('\n')).toContain(
      '每页 6 条',
    );
    expect(
      markdowns(
        historyCard([{ sessionId: 's1', updatedAtMs: Date.now(), turns: 1, workspace: 'w' }], {
          mode: 'cwd',
          cwd: '/tmp/x',
          offset: 0,
          total: 1,
        }),
      ).join('\n'),
    ).toContain('每页 8 条');
  });
});
