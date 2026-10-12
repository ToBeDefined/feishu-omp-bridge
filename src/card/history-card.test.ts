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

/** Every grey content block of a card. */
function greyBlocks(card: { body: { elements: Array<Record<string, unknown>> } }): unknown[] {
  return card.body.elements.filter(
    (e) =>
      e.tag === 'column_set' &&
      (e.columns as Array<{ background_style?: string }>)[0]?.background_style === 'grey',
  );
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
    expect(card).toContain('🔁 12 轮');
    expect(card).toContain('🔗 019f9432…');
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
    const rows = [row({ title: '会话 UI 优化' }), row({ sessionId: 'x'.repeat(26), topic: '看下 FC1 在做什么' })];
    const card = historyCard(rows, { mode: 'all', offset: 0, total: 2 });
    const text = JSON.stringify(card);
    expect(text.match(/会话 UI 优化/g)?.length).toBe(1);
    expect(text.match(/看下 FC1 在做什么/g)?.length).toBe(1);
    // Exactly one grey row block per row.
    const parsed = card as { body: { elements: Array<Record<string, unknown>> } };
    expect(greyBlocks(parsed)).toHaveLength(2);
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
    // Pager first, then the 工作区范围切换键（all → cwd）。
    expect(buttonValues(first)).toEqual([
      { cmd: 'history.page', arg: `all ${HISTORY_PAGE_SIZE}` },
      { cmd: 'history.page', arg: 'cwd 0' },
    ]);
    expect(JSON.stringify(first)).toContain('第 1-8 个');
    expect(JSON.stringify(first)).toContain('↓ 下一页（剩 12）');

    // Middle page: both directions, each pointing one page back/forward.
    const middle = historyCard(rows, { mode: 'all', offset: 8, total: 20 });
    expect(buttonValues(middle)).toEqual([
      { cmd: 'history.page', arg: 'all 0' },
      { cmd: 'history.page', arg: 'all 16' },
      { cmd: 'history.page', arg: 'cwd 0' },
    ]);
    expect(JSON.stringify(middle)).toContain('↓ 下一页（剩 4）');
    // `↑ 上一页` renders before `↓ 下一页`.
    const middleJson = JSON.stringify(middle);
    expect(middleJson.indexOf('上一页')).toBeLessThan(middleJson.indexOf('下一页'));

    // Last page: back only.
    const last = historyCard(rows, { mode: 'all', offset: 16, total: 20 });
    expect(buttonValues(last)).toEqual([
      { cmd: 'history.page', arg: 'all 8' },
      { cmd: 'history.page', arg: 'cwd 0' },
    ]);
  });

  it('exposes an explicit all-workspaces entry that reuses the pager pipeline', () => {
    // cwd 模式 → 一键切到 all（第一页），用户不必知道有 `/history all`。
    const cwd = historyCard([row()], { mode: 'cwd', offset: 0, total: 1 });
    expect(allButtons(cwd)).toContainEqual({
      cmd: 'history.page',
      arg: 'all 0',
      label: '🌐 全部工作区',
    });
    // all 模式 → 一键切回当前工作区。
    const all = historyCard([row()], { mode: 'all', offset: 0, total: 1 });
    expect(allButtons(all)).toContainEqual({
      cmd: 'history.page',
      arg: 'cwd 0',
      label: '📂 当前工作区',
    });
  });

  it('has no pager on a single short page but still offers the scope switch', () => {
    const card = historyCard([row(), row({ sessionId: 's2' })], { mode: 'cwd', offset: 0, total: 2 });
    // 没有翻页键，但工作区范围入口仍在（这是默认视图唯一通往 all 的路）。
    expect(buttonValues(card)).toEqual([{ cmd: 'history.page', arg: 'all 0' }]);
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
      { cmd: 'history.page', arg: 'all 0', label: '🌐 全部工作区' },
    ]);
    // Row = grey content block, then its action side by side underneath.
    const parsed = card as { body: { elements: Array<Record<string, unknown>> } };
    expect(greyBlocks(parsed)).toHaveLength(1);
    // 1 个灰底行块 + 1 个行动作块（继续对话）+ 1 个页脚范围切换块。
    expect(parsed.body.elements.filter((e) => e.tag === 'column_set')).toHaveLength(3);
  });

  it('marks the current session instead of offering a no-op resume', () => {
    const current = '01a11d26-5f7a-7106-be95-17618cbbaf57';
    const card = historyCard(
      [row({ sessionId: current, title: 'bridge UI 调整' }), row({ sessionId: 'other-session-id-0000' })],
      { mode: 'cwd', offset: 0, total: 2, currentSessionId: current },
    );
    const buttons = allButtons(card);
    // Only the OTHER row can be resumed.
    expect(buttons.filter((b) => b.cmd === 'history.resume').map((b) => b.arg)).toEqual([
      'other-session-id-0000',
    ]);
    // The marker sits right behind the row number, not in the small meta line.
    expect(JSON.stringify(card)).toContain('**#1** ⭐ 当前 · 🏷 **bridge UI 调整**');
    const markdown = [...JSON.stringify(card).matchAll(/"tag":"markdown","content":"((?:[^"\\]|\\.)*)"/g)].map(
      (m) => m[1]!,
    );
    expect(markdown.some((c) => c.includes('⭐ 当前'))).toBe(true);
    expect(markdown.some((c) => c.includes('🔗') && c.includes('⭐ 当前'))).toBe(false);
    // The current row keeps its grey block but has no action row at all.
    const parsed = card as { body: { elements: Array<Record<string, unknown>> } };
    expect(greyBlocks(parsed)).toHaveLength(2);
    // 2 个灰底块 + 1 个非当前行的动作块 + 页脚的工作区范围切换块 = 4。
    expect(parsed.body.elements.filter((e) => e.tag === 'column_set')).toHaveLength(4);
  });

  it('carries exactly one 继续对话 button per row', () => {
    const card = JSON.stringify(
      historyCard([row(), row({ sessionId: 's2' })], { mode: 'cwd', offset: 0, total: 2 }),
    );
    const buttons = allButtons(JSON.parse(card) as object);
    // 每行一个 继续对话，页脚再挂一个工作区范围切换键。
    expect(buttons.map((b) => b.label)).toEqual(['继续对话', '继续对话', '🌐 全部工作区']);
  });

  it('renders a real empty state instead of a dead end', () => {
    const card = JSON.stringify(historyCard([], { mode: 'cwd', cwd: '/repo/x', offset: 0, total: 0 }));
    // 空态给出下一步文案，不再引用一个根本不存在的「继续对话」按钮。
    expect(card).toContain('暂无历史会话');
    expect(card).not.toContain('继续对话');
    // 没有悬空的分隔线：空态卡里一条 hr 都没有。
    expect(card).not.toContain('"tag":"hr"');
  });

  it('never prints a reversed span when the offset is past the end', () => {
    // Stale card button: offset 8 but only 2 sessions exist.
    const card = JSON.stringify(historyCard([row(), row({ sessionId: 's2' })], {
      mode: 'cwd',
      cwd: '/repo/x',
      offset: 8,
      total: 2,
    }));
    expect(card).not.toContain('第 9-8');
    expect(card).not.toContain('第 9-');
    expect(card).toContain('没有更多了');
  });

  it('never emits the retired 🆔 session marker (🔗 is the house glyph)', () => {
    const card = JSON.stringify(historyCard([row()], { mode: 'cwd', offset: 0, total: 1 }));
    expect(card).not.toContain('🆔');
    expect(card).toContain('🔗');
  });
});
