import { describe, expect, it } from 'vitest';
import {
  renderSearchContext,
  searchDetailCard,
  searchEmptyCard,
  searchResultsCard,
  type SearchContext,
} from './search-card';

function sampleContext(over: Partial<SearchContext> = {}): SearchContext {
  const messages = over.messages ?? [{ role: 'user' as const, content: '问题' }];
  return {
    workSessionId: 'sess-1',
    workspace: '~/repo',
    title: '标题',
    matchCount: 1,
    groups: [
      { segmentId: 'sess-1', messages, hitIndex: 0, matchCount: over.matchCount ?? 1 },
    ],
    messages,
    hitIndex: 0,
    ...over,
  };
}

describe('search-card T10 additions', () => {
  it('highlights the keyword in rendered context (case-insensitive)', () => {
    const out = renderSearchContext(
      { messages: [{ role: 'user', content: 'KW 出现在句首，句中也有 kw。' }], hitIndex: 0 },
      'compact',
      'kw',
    );
    expect(out).toContain('**KW**');
    expect(out).toContain('**kw**');
  });

  it('leaves text untouched without a keyword', () => {
    const out = renderSearchContext(
      { messages: [{ role: 'user', content: '普通一句话' }], hitIndex: 0 },
      'compact',
    );
    expect(out).toContain('普通一句话');
    expect(out).not.toContain('**普通');
  });

  it('splits the row into a heading identity line and a small meta line', () => {
    const UUID = '019f9432-b808-7000-8bf4-073defc52637';
    const out = searchResultsCard(
      'kw',
      [
        sampleContext({
          workSessionId: UUID,
          title: '会话 UI',
          workspace: '~/repo',
          matchCount: 3,
          messages: [
            { role: 'user', content: 'kw 在这里', timestamp: new Date().toISOString() },
          ],
        }),
      ],
      'q1',
    );
    const json = JSON.stringify(out);
    // Heading line: number + title only.
    expect(json).toContain('"content":"#1 · 🏷 会话 UI","text_size":"heading"');
    // Meta line rides below it at notation size, with an 8-char id handle.
    expect(json).toContain('"content":"📁 ~/repo · 🕘 0 秒前 · 🔎 3 处匹配 · 🆔 019f9432…","text_size":"notation"');
    // The 36-char UUID never lands in the oversized line.
    const heading = (out as { body: { elements: Array<{ content?: string; text_size?: string }> } })
      .body.elements.filter((e) => e.text_size === 'heading')
      .map((e) => e.content ?? '');
    expect(heading.join('\n')).not.toContain(UUID);
  });

  it('shows relative time and pagination in the results card', () => {
    const contexts = Array.from({ length: 8 }, (_, i) => ({
      ...sampleContext({ workSessionId: `s${i}` }),
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

    const page2 = JSON.stringify(searchResultsCard('kw', contexts, 'q9', true, 6));
    expect(page2).toContain('第 7-8 个');
    expect(page2).toContain('上一页');
    expect(page2).toContain('"arg":"q9 0"');
    expect(page2).toContain('#7');
    expect(page2).toContain('#8');
  });

  it('renders the empty-hit card', () => {
    const out = JSON.stringify(searchEmptyCard('foo'));
    expect(out).toContain('没有找到包含');
    expect(out).toContain('foo');
  });
});

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

  it('pages results past the per-card cap', () => {
    const many = Array.from({ length: 8 }, (_, i) => sampleContext({ workSessionId: `s${i}` }));
    const card = searchResultsCard('foo', many, 'q1', true);
    const body = JSON.stringify(card);
    // 8 items → first page renders #1..#6 headings; #7 rides page 2.
    expect(body).toContain('"content":"#6 ·');
    expect(body).not.toContain('"content":"#7 ·');
    expect(body).toContain('下一页（剩 2）');
  });

  it('shows a match count when a session has multiple hits', () => {
    const card = searchResultsCard('foo', [sampleContext({ matchCount: 3 })], 'q1', true);
    expect(JSON.stringify(card)).toContain('🔎 3 处匹配');
  });

  it('renders all items in the done (settled) view', () => {
    const many = Array.from({ length: 8 }, (_, i) => sampleContext({ workSessionId: `s${i}` }));
    const done = JSON.stringify(searchResultsCard('foo', many, 'q1', false));
    expect(done).toContain('"content":"#8 ·');
  });

  it('annotates a multi-segment work session with its segment count', () => {
    const card = JSON.stringify(
      searchResultsCard('foo', [sampleContext({ segmentCount: 3, matchCount: 4 })], 'q1', true),
    );
    expect(card).toContain('🧵 3 段');
    expect(card).toContain('🔎 4 处匹配');
    // A single-segment work session does not advertise its segment count.
    expect(JSON.stringify(searchResultsCard('foo', [sampleContext()], 'q1', true))).not.toContain(
      '🧵',
    );
  });

  it('lists each matched segment under one heading, labelled by segment', () => {
    const card = JSON.stringify(
      searchResultsCard(
        'foo',
        [
          sampleContext({
            workSessionId: 'ws-1',
            groups: [
              {
                segmentId: '019f9432-b808-7000-8bf4-073defc52637',
                messages: [{ role: 'user', content: '新段命中' }],
                hitIndex: 0,
                matchCount: 1,
              },
              {
                segmentId: 'old-segment-01',
                messages: [{ role: 'assistant', content: '旧段命中' }],
                hitIndex: 0,
                matchCount: 1,
              },
            ],
          }),
        ],
        'q1',
        true,
      ),
    );
    // Exactly one heading for the work session; both segments' hits follow it.
    expect(card.match(/"text_size":"heading"/g)).toHaveLength(1);
    expect(card).toContain('新段命中');
    expect(card).toContain('旧段命中');
    // Each hit block is labelled with its (short) segment id.
    expect(card).toContain('🧵 段 `019f9432…`');
    expect(card).toContain('🧵 段 `old-segm…`');
  });

  it('renders a topic fallback when the work session is unnamed', () => {
    const card = JSON.stringify(
      searchResultsCard('foo', [sampleContext({ title: undefined, topic: '看下 FC1 在做什么' })], 'q1', true),
    );
    expect(card).toContain('**看下 FC1 在做什么**');
    expect(card).not.toContain('🏷');
  });
});

describe('searchDetailCard', () => {
  it('keeps number / workspace / session in the done header', () => {
    const done = JSON.stringify(
      searchDetailCard('sess-9', 'content', undefined, 3, true, '~/ws'),
    );
    // Heading carries the identity; workspace + FULL session id ride in a
    // small meta line (a 36-char UUID must not be heading-sized).
    expect(done).toContain('✅ **搜索结果 #3**');
    expect(done).toContain('"text_size":"heading"');
    expect(done).toContain('📁 ~/ws · 🆔 sess-9');
    expect(done).toContain('"text_size":"notation"');
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
