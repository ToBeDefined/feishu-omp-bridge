import { describe, expect, it } from 'vitest';
import { HISTORY_PAGE_SIZE, historyCard, type HistoryRow } from './history-card';

const NOW = Date.now();

function row(over: Partial<HistoryRow> = {}): HistoryRow {
  return {
    sessionId: '019f9432-b808-7000-8bf4-073defc52637',
    updatedAtMs: NOW - 3_600_000,
    turns: 12,
    workspace: 'bridge',
    ...over,
  };
}

function allButtons(card: object): Array<{ cmd: string; arg: string; label: string }> {
  const found: Array<{ cmd: string; arg: string; label: string }> = [];
  const walk = (node: unknown): void => {
    if (!node || typeof node !== 'object') return;
    const o = node as Record<string, unknown>;
    if (o.tag === 'button') {
      const text = o.text as { content?: string } | undefined;
      found.push({ ...(o.value as { cmd: string; arg: string }), label: text?.content ?? '' });
    }
    for (const v of Object.values(o)) {
      if (Array.isArray(v)) v.forEach(walk);
      else if (typeof v === 'object') walk(v);
    }
  };
  walk(card);
  return found;
}

/** Pager buttons only — row resume buttons are asserted separately. */
function buttonValues(card: object): Array<{ cmd: string; arg: string }> {
  return allButtons(card)
    .filter((b) => b.cmd === 'history.page')
    .map(({ cmd, arg }) => ({ cmd, arg }));
}

describe('historyCard', () => {
  it('renders the identity, activity time, turn count and id handle per row', () => {
    const card = JSON.stringify(
      historyCard([row({ title: '会话 UI 优化', topic: '按钮在电脑上很奇怪' })], {
        mode: 'cwd',
        cwd: '/Users/tbd/Git/Other/feishu-omp-bridge',
        offset: 0,
        total: 1,
      }),
    );
    expect(card).toContain('🏷 **会话 UI 优化**');
    expect(card).toContain('💬 12 轮');
    expect(card).toContain('🆔 019f9432…');
    // A named session still shows what the conversation contained.
    expect(card).toContain('按钮在电脑上很奇怪');
    // Header carries the workspace, so rows do not repeat it.
    expect(card).toContain('feishu-omp-bridge');
    expect(card).not.toContain('📁');
  });

  it('falls back from title to topic to 未命名', () => {
    const withTopic = JSON.stringify(
      historyCard([row({ topic: '先看 A 的调用链' })], { mode: 'cwd', offset: 0, total: 1 }),
    );
    expect(withTopic).toContain('**先看 A 的调用链**');

    const bare = JSON.stringify(historyCard([row()], { mode: 'cwd', offset: 0, total: 1 }));
    expect(bare).toContain('未命名会话');
  });

  it('renders each row identity exactly ONCE', () => {
    // Regression: the identity was pushed as a top-level element AND again
    // inside the row's column, so every row showed its title twice.
    const rows = [
      row({ title: '会话 UI 优化' }),
      row({ sessionId: 'x'.repeat(26), topic: '看下 FC1 在做什么' }),
    ];
    const card = historyCard(rows, { mode: 'all', offset: 0, total: 2 });
    const text = JSON.stringify(card);
    expect(text.match(/会话 UI 优化/g)?.length).toBe(1);
    expect(text.match(/看下 FC1 在做什么/g)?.length).toBe(1);
    // Exactly one row container per row.
    const elements = (card as { body: { elements: Array<Record<string, unknown>> } }).body.elements;
    expect(elements.filter((e) => e.tag === 'column_set' && e.flex_mode === 'none')).toHaveLength(2);
  });

  it("shows each row's workspace only in all-mode", () => {
    const rows = [row({ workspace: 'bridge' }), row({ sessionId: 's2', workspace: '/tmp/other' })];
    const all = JSON.stringify(historyCard(rows, { mode: 'all', offset: 0, total: 2 }));
    expect(all).toContain('📁 bridge');
    expect(all).toContain('📁 /tmp/other');
    expect(all).toContain('全部工作区 · 2 个会话');
  });

  it('pages 8 rows per card and points the pager at the right offset', () => {
    const rows = Array.from({ length: 20 }, (_, i) =>
      row({ sessionId: `019f9432-0000-7000-8bf4-${String(i).padStart(12, '0')}` }),
    );
    const first = historyCard(rows, { mode: 'all', offset: 0, total: 20 });
    expect(buttonValues(first)).toEqual([{ cmd: 'history.page', arg: `all ${HISTORY_PAGE_SIZE}` }]);
    expect(JSON.stringify(first)).toContain('第 1-8 个');
    expect(JSON.stringify(first)).toContain('↓ 更早（剩 12）');

    // Middle page: both directions, each pointing one page back/forward.
    const middle = historyCard(rows, { mode: 'all', offset: 8, total: 20 });
    expect(buttonValues(middle)).toEqual([
      { cmd: 'history.page', arg: 'all 0' },
      { cmd: 'history.page', arg: 'all 16' },
    ]);
    expect(JSON.stringify(middle)).toContain('↓ 更早（剩 4）');
    // `↑ 较新的` renders before `↓ 更早`.
    const middleJson = JSON.stringify(middle);
    expect(middleJson.indexOf('较新的')).toBeLessThan(middleJson.indexOf('更早'));

    // Last page: back only.
    const last = historyCard(rows, { mode: 'all', offset: 16, total: 20 });
    expect(buttonValues(last)).toEqual([{ cmd: 'history.page', arg: 'all 8' }]);
  });

  it('has no pager on a single short page and says where to go instead', () => {
    const card = historyCard([row(), row({ sessionId: 's2' })], { mode: 'cwd', offset: 0, total: 2 });
    expect(buttonValues(card)).toEqual([]);
    expect(JSON.stringify(card)).toContain('点「继续对话」接着聊');
  });

  it('gives every row a 继续对话 button carrying its full session id', () => {
    const card = historyCard([row({ sessionId: '019f9432-b808-7000-8bf4-073defc52637' })], {
      mode: 'cwd',
      offset: 0,
      total: 1,
    });
    const buttons = allButtons(card);
    expect(buttons).toEqual([
      {
        cmd: 'history.resume',
        arg: '019f9432-b808-7000-8bf4-073defc52637',
        label: '继续对话',
      },
    ]);
    // Row = weighted content column + auto button column: `width` only applies
    // under flex_mode 'none', and weighted absorbs the slack so the button is
    // neither stretched across the card nor squeezed.
    const rowSet = (card as { body: { elements: Array<Record<string, unknown>> } }).body
      .elements.filter((e) => e.tag === 'column_set')[0]!;
    const cols = rowSet.columns as Array<Record<string, unknown>>;
    expect(rowSet.flex_mode).toBe('none');
    expect(cols.map((c) => c.width)).toEqual(['weighted', 'auto']);
  });

  it('marks the current session instead of offering a no-op resume', () => {
    const current = '01a11d26-5f7a-7106-be95-17618cbbaf57';
    const card = historyCard(
      [row({ sessionId: current, title: 'bridge UI 调整' }), row({ sessionId: 'other-session-id-0000' })],
      { mode: 'cwd', offset: 0, total: 2, currentSessionId: current },
    );
    const buttons = allButtons(card);
    // Only the OTHER row can be resumed.
    expect(buttons.map((b) => b.arg)).toEqual(['other-session-id-0000']);
    // The marker sits right behind the row number, not in the small meta line.
    expect(JSON.stringify(card)).toContain('**#1** ✅ 当前 · 🏷 **bridge UI 调整**');
    const markdown = [...JSON.stringify(card).matchAll(/"tag":"markdown","content":"((?:[^"\\]|\\.)*)"/g)].map(
      (m) => m[1]!,
    );
    expect(markdown.some((c) => c.includes('✅ 当前'))).toBe(true);
    expect(markdown.some((c) => c.includes('🆔') && c.includes('✅ 当前'))).toBe(false);
    // The current row is a single-column layout (no button column).
    const sets = (card as { body: { elements: Array<Record<string, unknown>> } }).body.elements.filter(
      (e) => e.tag === 'column_set',
    );
    expect((sets[0]!.columns as unknown[]).length).toBe(1);
    expect((sets[1]!.columns as unknown[]).length).toBe(2);
  });
});
