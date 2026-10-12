import { describe, expect, it } from 'vitest';
import { resumeSavedCard } from './model-card';
import type { RunCard } from './run-renderer';
import {
  agentSelectedCard,
  compactCard,
  cwdChangedCard,
  everyCard,
  execResultCard,
  confirmActions,
  helpCard,
  inlineActions,
  inlineRow,
  INLINE_ROW_MAX,
  md,
  newSessionCard,
  psCard,
  panel,
  onlineCard,
  releaseCard,
  restartCard,
  shell,
  staleNoticeCard,
  statusCard,
  timeoutCard,
  type ContextInfo,
  workspacesCard,
} from './templates';

describe('releaseCard', () => {
  function assertNoBareColumns(card: RunCard): void {
    // cardkit 11310: 裸 column（父级不是 column_set）会被整卡拒收。递归扫
    // 全部层级，按父级 tag 判断合法性。
    const walk = (elements: unknown[], parent: string): void => {
      for (const el of elements) {
        if (typeof el !== 'object' || el === null) continue;
        const tag = 'tag' in el ? String(el.tag) : '';
        if (tag === 'column' && parent !== 'column_set') {
          throw new Error('bare column outside column_set');
        }
        const nested = 'elements' in el && Array.isArray(el.elements) ? el.elements : [];
        const cols = 'columns' in el && Array.isArray(el.columns) ? el.columns : [];
        walk(cols, tag === 'column_set' ? 'column_set' : tag || parent);
        walk(nested, tag || parent);
      }
    };
    walk(card.body.elements, 'body');
  }

  it('shows per-step states while running', () => {
    const card = releaseCard({
      phase: 'running',
      steps: [
        { name: 'typecheck', status: 'ok' },
        { name: 'test', status: 'running' },
        { name: 'build', status: 'pending' },
      ],
    });
    assertNoBareColumns(card);
    const out = JSON.stringify(card);
    expect(out).toContain('正在发布');
    expect(out).toContain('✅ 类型检查');
    expect(out).toContain('⏳ 测试');
    expect(out).toContain('⭕️ 构建');
  });

  it('renders the failure tail when a step fails', () => {
    const out = JSON.stringify(
      releaseCard({
        phase: 'failed',
        steps: [{ name: 'typecheck', status: 'failed' }],
        failStep: 'typecheck',
        failNote: '退出码 2',
        output: 'error TS1234: x',
      }),
    );
    expect(out).toContain('发布失败于 类型检查');
    expect(out).toContain('退出码 2');
    expect(out).toContain('error TS1234: x');
  });

  it('renders the success phase', () => {
    const out = JSON.stringify(
      releaseCard({
        phase: 'success',
        steps: [
          { name: 'typecheck', status: 'ok' },
          { name: 'test', status: 'ok' },
          { name: 'build', status: 'ok' },
        ],
      }),
    );
    expect(out).toContain('已发布上线');
  });

  it('renders the drain wait as the current step, with count and cap', () => {
    const card = releaseCard({
      phase: 'running',
      steps: [
        { name: 'typecheck', status: 'ok' },
        { name: 'test', status: 'ok' },
        { name: 'build', status: 'ok' },
      ],
      drain: { runningCount: 3, timeoutMs: 5 * 60_000 },
    });
    assertNoBareColumns(card);
    const out = JSON.stringify(card);
    // 排空阶段不再是「三个步骤全打勾、后面空着」的假死画面。
    expect(out).toContain('⏳ 等待 3 个在跑的会话收尾（最多 5 分钟）');
    expect(out).toContain('✅ 构建');
    expect(out).not.toContain('⭕️ 构建');
  });

  it('keeps the drain step visible when no pipeline step reported yet', () => {
    const out = JSON.stringify(
      releaseCard({
        phase: 'running',
        steps: [],
        drain: { runningCount: 1, timeoutMs: 60_000 },
      }),
    );
    expect(out).toContain('等待 1 个在跑的会话收尾（最多 1 分钟）');
    expect(out).toContain('column_set');
  });
});
describe('releaseCard force cost', () => {
  it('spells out how many running runs a forced restart cuts off', () => {
    const out = JSON.stringify(
      releaseCard({ steps: [], phase: 'restarting', forced: true, interruptedCount: 2 }),
    );
    expect(out).toContain('强制重启');
    expect(out).toContain('中断 2 个在跑的会话');
  });

  it('says nothing was running instead of 「中断 0 个」', () => {
    const out = JSON.stringify(
      releaseCard({ steps: [], phase: 'restarting', forced: true, interruptedCount: 0 }),
    );
    expect(out).toContain('无在跑会话');
    expect(out).not.toContain('中断 0 个');
  });
});
describe('restartCard', () => {
  it('renders starting, done, and failed states as distinct headings', () => {
    expect(JSON.stringify(restartCard('starting'))).toContain('正在重启');
    expect(JSON.stringify(restartCard('done'))).toContain('重启完成');
    expect(JSON.stringify(restartCard('failed', 'launchctl failed'))).toContain('launchctl failed');
  });

  it('marks a forced restart, so a cut-off run is not read as an anomaly', () => {
    expect(JSON.stringify(restartCard('starting', undefined, { forced: true }))).toContain('强制重启');
    expect(JSON.stringify(restartCard('starting'))).not.toContain('强制重启');
  });

  it('shows the drain wait with the running count and cap', () => {
    const out = JSON.stringify(
      restartCard('draining', undefined, { runningCount: 2, timeoutMs: 5 * 60_000 }),
    );
    expect(out).toContain('正在等待 2 个在跑的会话收尾');
    expect(out).toContain('收尾');
    expect(out).toContain('最多 5 分钟');
  });

  it('时限由调用方给定：没给时限就不自己编一个「最多 N 分钟」', () => {
    const withEta = JSON.stringify(
      restartCard('draining', undefined, { runningCount: 2, timeoutMs: 5 * 60_000 }),
    );
    expect(withEta).toContain('最多 5 分钟');
    const noEta = JSON.stringify(restartCard('draining', undefined, { runningCount: 2 }));
    expect(noEta).toContain('正在等待 2 个在跑的会话收尾');
    expect(noEta).not.toContain('最多');
  });

  it('says nothing about waiting when no run is in flight', () => {
    const out = JSON.stringify(restartCard('starting', undefined, { runningCount: 0 }));
    expect(out).toContain('服务即将重启');
    expect(out).not.toContain('收尾');
    expect(out).not.toContain('等待');
  });

  it('writes the interrupted count for force, and no 「中断 0 个」', () => {
    const busy = JSON.stringify(
      restartCard('starting', undefined, { forced: true, runningCount: 3 }),
    );
    expect(busy).toContain('强制重启');
    expect(busy).toContain('中断 3 个在跑的会话');

    const idle = JSON.stringify(restartCard('starting', undefined, { forced: true, runningCount: 0 }));
    expect(idle).toContain('无在跑会话');
    expect(idle).not.toContain('中断 0 个');
  });
});

describe('compactCard', () => {
  it('shows the size estimate while running', () => {
    const out = JSON.stringify(
      compactCard({ phase: 'started', tokensK: '690', mb: '10.0', eta: '15分30秒', cap: '46分' }),
    );
    expect(out).toContain('正在压缩会话上下文');
    expect(out).toContain('**690k** token');
    expect(out).toContain('**10.0** MB');
    expect(out).toContain('15分30秒');
    expect(out).toContain('46分');
  });

  it('omits the size line without an estimate', () => {
    const out = JSON.stringify(compactCard({ phase: 'started' }));
    expect(out).not.toContain('k token');
    expect(out).toContain('无法估算');
  });

  it('renders done and failed phases', () => {
    const done = JSON.stringify(compactCard({ phase: 'done' }));
    expect(done).toContain('会话上下文已压缩');
    const failed = JSON.stringify(compactCard({ phase: 'failed', error: 'killed' }));
    expect(failed).toContain('压缩失败');
    expect(failed).toContain('killed');
  });
});

/** every 卡的元素 0 是标题，之后每个任务一个 collapsible_panel。 */
interface EveryPanelCard {
  body: { elements: Array<{ tag: string; header?: { title: { content: string } } }> };
}

describe('everyCard', () => {
  it('lists tasks with delete buttons and the full prompt', () => {
    const out = JSON.stringify(
      everyCard([
        { id: 't1', interval: '30 分钟', nextRun: '14:00', prompt: '检查 CI 状态并汇报' },
        { id: 't2', interval: '1 天', nextRun: '09:00', prompt: 'daily standup 摘要' },
      ]),
    );
    expect(out).toContain('×2');
    expect(out).toContain('30 分钟');
    expect(out).toContain('14:00');
    expect(out).toContain('检查 CI 状态并汇报');
    expect(out).toContain('"arg":"t1"');
    expect(out).toContain('"arg":"t2"');
  });

  it('renders the empty state hint when no tasks', () => {
    const out = JSON.stringify(everyCard([]));
    expect(out).not.toContain('×');
    expect(out).toContain('暂无定时任务');
  });

  it('截断过长的 prompt：补省略号，含省略号共 40 字', () => {
    const long = '一二三四五六七八九十'.repeat(6);
    const card = everyCard([
      { id: 't1', interval: '30 分钟', nextRun: '14:00', prompt: long },
    ]) as EveryPanelCard;
    const title = card.body.elements[1]?.header?.title.content ?? '';
    expect(title.endsWith('…')).toBe(true);
    const shown = title.slice(title.indexOf('— ') + 2);
    expect(shown).toBe(`${long.slice(0, 39)}…`);
    expect(shown).toHaveLength(40);
    // 完整指令仍留在面板里的代码块（标题只是摘要）。
    expect(JSON.stringify(card)).toContain(long);
  });

  it('不截断刚好 40 字的 prompt（也就不会多出省略号）', () => {
    const exact = '甲'.repeat(40);
    const card = everyCard([
      { id: 't1', interval: '1 天', nextRun: '09:00', prompt: exact },
    ]) as EveryPanelCard;
    const title = card.body.elements[1]?.header?.title.content ?? '';
    expect(title).toContain(exact);
    expect(title.endsWith('…')).toBe(false);
  });
});

describe('psCard', () => {
  it('marks the current process and wires exit buttons per row', () => {
    const out = JSON.stringify(
      psCard([
        { id: 'p1', appId: 'cli_a', botName: '尼莫', startedAgo: '3 小时前', isCurrent: true },
        { id: 'p2', appId: 'cli_b', startedAgo: '2 分钟前', isCurrent: false },
      ]),
    );
    expect(out).toContain('×2');
    expect(out).toContain('⭐ 当前');
    expect(out).toContain('尼莫');
    expect(out).toContain('"arg":"p2"');
    expect(out).toContain('"arg":"p1"');
    expect(out).toContain('3 小时前');
  });

  it('首态不直接执行退出：只有 exit.ask，真正的 exit 只在确认态', () => {
    const out = JSON.stringify(
      psCard([{ id: 'p1', appId: 'cli_a', startedAgo: '刚刚', isCurrent: false }]),
    );
    expect(out).toContain('"cmd":"exit.ask","arg":"p1"');
    // 没有首击即杀的按钮。
    expect(out).not.toContain('"cmd":"exit","arg":"p1"');
  });

  it('确认态：确认按钮的执行 arg 仍是被点的进程 id，并带当前进程额外警示', () => {
    const sel = JSON.stringify(
      psCard([{ id: 'p1', appId: 'cli_a', startedAgo: '刚刚', isCurrent: false }], {
        confirmId: 'p1',
      }),
    );
    expect(sel).toContain('"cmd":"exit","arg":"p1"');
    expect(sel).not.toContain('"cmd":"exit.ask","arg":"p1"');
    expect(sel).toContain('"cmd":"exit.cancel","arg":"p1"');

    const self = JSON.stringify(
      psCard([{ id: 'p1', appId: 'cli_a', startedAgo: '刚刚', isCurrent: true }], {
        confirmId: 'p1',
      }),
    );
    expect(self).toContain('正在回复你的进程');
  });

  it('exitingSelf：告别态，不再渲染任何退出按钮', () => {
    const out = JSON.stringify(
      psCard([{ id: 'p1', appId: 'cli_a', startedAgo: '刚刚', isCurrent: true }], {
        exitingSelf: true,
      }),
    );
    expect(out).toContain('即将退出');
    expect(out).not.toContain('"cmd":"exit');
  });

  it('renders a single process without the count noise', () => {
    const out = JSON.stringify(
      psCard([{ id: 'p1', appId: 'cli_a', startedAgo: '刚刚', isCurrent: true }]),
    );
    expect(out).toContain('×1');
  });
});

describe('execResultCard', () => {
  it('renders success with collapsed output and the command line', () => {
    const out = JSON.stringify(
      execResultCard({ cmd: 'pnpm test', cwd: '/repo/app', exitCode: 0, output: 'all green', timedOut: false, timeoutSeconds: 30 }),
    );
    expect(out).toContain('命令执行完成');
    expect(out).toContain('$ pnpm test');
    // 执行目录单独一行：命令在哪跑的，是失败排查的第一现场。
    expect(out).toContain('📁 `/repo/app`');
    expect(out).toContain('"expanded":false');
    expect(out).toContain('all green');
  });

  it('shortens a deep cwd in the exec card', () => {
    const out = JSON.stringify(
      execResultCard({
        cmd: 'pwd',
        cwd: '/Users/somebody/very/deep/nested/project/dir',
        exitCode: 0,
        output: '/x',
        timedOut: false,
        timeoutSeconds: 30,
      }),
    );
    expect(out).toContain('📁 `…');
    expect(out).not.toContain('/Users/somebody/very/deep');
  });

  it('expands output and marks failure on non-zero exit', () => {
    const out = JSON.stringify(
      execResultCard({ cmd: 'boom', cwd: '/repo', exitCode: 2, output: 'err', timedOut: false, timeoutSeconds: 30 }),
    );
    expect(out).toContain('命令失败**（退出码 2）');
    expect(out).toContain('"expanded":true');
    expect(out).toContain('"color":"red"');
  });

  it('names the reason it could not run, not just 无法执行', () => {
    const out = JSON.stringify(
      execResultCard({
        cmd: 'ls',
        cwd: '/gone',
        exitCode: null,
        output: '',
        timedOut: false,
        timeoutSeconds: 30,
        reason: '执行目录不存在',
      }),
    );
    expect(out).toContain('无法执行**：执行目录不存在');
    expect(out).toContain('📁 `/gone`');
    expect(out).not.toContain('原因未知');
  });

  it('falls back to 原因未知 when the caller has none', () => {
    const out = JSON.stringify(
      execResultCard({ cmd: 'ls', cwd: '/repo', exitCode: null, output: '', timedOut: false, timeoutSeconds: 30 }),
    );
    expect(out).toContain('无法执行**：原因未知');
  });

  it('marks timeouts and empty output', () => {
    const out = JSON.stringify(
      execResultCard({ cmd: 'sleep 100', cwd: '/repo', exitCode: null, output: '', timedOut: true, timeoutSeconds: 30 }),
    );
    expect(out).toContain('执行超时**（30s）');
    expect(out).toContain('无输出');
  });
});

describe('shared card kit', () => {
  it('exports the 2.0 kit pieces for other card modules', () => {
    expect(shell('预览', [md('正文')])).toMatchObject({
      schema: '2.0',
      config: { summary: { content: '预览' } },
    });
    expect(md('x', 'notation')).toMatchObject({ text_size: 'notation' });
    expect(panel([md('k')])).toMatchObject({ tag: 'column', background_style: 'grey' });
    expect(inlineActions([{ text: 'go', value: { cmd: 'x' } }])[0]).toMatchObject({
      tag: 'column_set',
    });
    expect(inlineRow([{ element: md('go') }])[0]).toMatchObject({ tag: 'column_set' });
  });

  it('staleNoticeCard 带 summary：通知/会话列表预览不是空灰块', () => {
    const card = staleNoticeCard();
    expect(card).toMatchObject({
      schema: '2.0',
      config: { update_multi: true, summary: { content: '⚠️ 卡片已过期' } },
    });
    expect(JSON.stringify(card)).toContain('此卡片已过期');
    // 过期卡不残留任何可点的按钮。
    expect(JSON.stringify(card)).not.toContain('"button"');
  });

  it('agentSelectedCard 的 summary 与正文同样转义', () => {
    const card = agentSelectedCard('a*b_c') as {
      config: { summary: { content: string } };
      body: { elements: Array<{ content: string }> };
    };
    const safe = 'a\\*b\\_c';
    expect(card.config.summary.content).toBe(`✅ 已选择 ${safe}`);
    expect(card.config.summary.content).not.toContain('a*b');
    expect(card.body.elements[0]?.content).toBe(`✅ 已选择：**${safe}**`);
  });

  it('lays parallel actions side by side, cancel full width underneath', () => {
    const rows = confirmActions(
      [
        { text: '确认', value: { cmd: 'a' }, style: 'primary' },
        { text: '否', value: { cmd: 'b' } },
      ],
      { text: '取消', value: { cmd: 'c' }, style: 'danger' },
    );
    // 规则 1：并列动作一行等宽；规则 2：取消单独一行铺满（一列 = 整行宽）。
    expect(rows).toHaveLength(2);
    const [pair, cancel] = rows as Array<{
      flex_mode: string;
      columns: Array<{ width: string; weight: number; elements: Array<Record<string, unknown>> }>;
    }>;
    expect(pair!.flex_mode).toBe('none');
    expect(pair!.columns.map((c) => c.weight)).toEqual([1, 1]);
    expect((pair!.columns[0]!.elements[0] as { text: { content: string } }).text.content).toBe('确认');
    expect(cancel!.columns).toHaveLength(1);
    expect(cancel!.columns[0]!.width).toBe('weighted');
    expect((cancel!.columns[0]!.elements[0] as { text: { content: string } }).text.content).toBe('取消');

    // 没有取消时只有并列那行。
    expect(confirmActions([{ text: '只有我', value: { cmd: 'x' } }])).toHaveLength(1);
  });

  it('offers a 新建会话 jump on the help card footer', () => {
    const card = helpCard() as { body: { elements: Array<Record<string, unknown>> } };
    const rows = card.body.elements.filter((e) => e.tag === 'column_set');
    const labels = rows.map((r) =>
      (r.columns as Array<{ elements: Array<{ text: { content: string } }> }>).map(
        (c) => c.elements[0]!.text.content,
      ),
    );
    // 4 个动作 → 每行最多 2 个 → 两行；新建会话在最前（速查卡里最常用）。
    expect(labels).toEqual([
      ['🆕 新建会话', '🕘 恢复会话'],
      ['📊 会话状态', '📂 工作空间'],
    ]);
    const json = JSON.stringify(card);
    expect(json).toContain('"cmd":"new"');
    // 按钮名 → `/new`（handlers 里注册的键），不是 `/🆕 新建会话`。
    expect(json).not.toContain('cmd":"🆕');
  });

  it('folds a third button onto its own row instead of compressing the labels', () => {
    // 回归：/help 页脚三个跳转等宽一行时，「📂 工作空间」在手机上被压到看不见文字。
    const rows = inlineActions([
      { text: '📊 会话状态', value: { cmd: 'status' }, style: 'primary' },
      { text: '🕘 恢复会话', value: { cmd: 'resume' } },
      { text: '📂 工作空间', value: { cmd: 'ws.list' } },
    ]);
    expect(rows).toHaveLength(2);
    const [first, second] = rows as Array<{ columns: Array<{ elements: Array<{ text: { content: string } }> }> }>;
    expect(first!.columns.map((c) => c.elements[0]!.text.content)).toEqual(['📊 会话状态', '🕘 恢复会话']);
    // 折下来的那个独占一行 = 整行宽（不再三等分）。
    expect(second!.columns).toHaveLength(1);
    expect(second!.columns[0]!.elements[0]!.text.content).toBe('📂 工作空间');
    expect(INLINE_ROW_MAX).toBe(2);
  });

  it('lays inline actions side by side in one weighted row', () => {
    const rows = inlineActions([
      { text: '继续对话', value: { cmd: 'search.resume' }, style: 'primary' },
      { text: '详情', value: { cmd: 'search.show' } },
    ]);
    expect(rows).toHaveLength(1);
    const row = rows[0] as {
      tag: string;
      flex_mode: string;
      columns: Array<{ width: string; weight: number; elements: Array<Record<string, unknown>> }>;
    };
    expect(row.tag).toBe('column_set');
    // Unlike actions() (stretch → one full-width row per button), these stay
    // side by side: equal weighted columns under `none`.
    expect(row.flex_mode).toBe('none');
    expect(row.columns.map((c) => [c.width, c.weight])).toEqual([
      ['weighted', 1],
      ['weighted', 1],
    ]);
    expect(row.columns[0]!.elements[0]).toMatchObject({
      tag: 'button',
      type: 'primary',
      text: { content: '继续对话' },
    });
    expect(row.columns[1]!.elements[0]).toMatchObject({ text: { content: '详情' } });

    // 长标签可以多分宽度（等宽会让它在手机上折行）。
    const wide = inlineActions([
      { text: '↑ 上一页', value: { cmd: 'a' } },
      { text: '↓ 下一页（剩 2）', value: { cmd: 'b' }, weight: 1.6 },
    ])[0] as { columns: Array<{ weight: number }> };
    expect(wide.columns.map((c) => c.weight)).toEqual([1, 1.6]);
  });

});

/** 合并后 `/status` · `/context` · `/ctx` 共用这一份输入。 */
function statusFixture(extra: Partial<ContextInfo> = {}): ContextInfo {
  return {
    cwd: '/repo',
    sessionId: 'ws-1',
    sessionStale: false,
    agentName: 'omp',
    scope: 'oc_1',
    chatMode: 'p2p',
    idleLine: '全局 30 分钟',
    running: false,
    wsNames: [],
    summary: {},
    ...extra,
  };
}

describe('statusCard', () => {
  it('shows the session name when set, and no title line when there is none', () => {
    const withName = JSON.stringify(statusCard(statusFixture({ sessionName: '修搜索' })));
    expect(withName).toContain('修搜索');

    // 没有名字就不渲染标题行：占位的「未命名」会让人以为会话有名字。
    const without = JSON.stringify(statusCard(statusFixture()));
    expect(without).not.toContain('未命名');
    expect(without).not.toContain('🏷');
  });

  it('renders as a schema 2.0 card with session and environment panels', () => {
    const card = statusCard(
      statusFixture({
        model: 'zhipu-coding-plan/glm-5.3',
        thinking: 'high',
        updatedAt: Date.now() - 5 * 60_000,
        running: true,
      }),
    );
    expect(card).toMatchObject({ schema: '2.0' });
    const out = JSON.stringify(card);
    // Panels + enriched fields
    expect(out).toContain('会话');
    expect(out).toContain('环境');
    expect(out).toContain('zhipu-coding-plan/glm-5.3');
    expect(out).toContain('high');
    expect(out).toContain('全局 30 分钟');
    expect(out).toContain('分钟前');
    expect(out).toContain('任务执行中');
  });

  it('carries the agent name and the workspace quick-dirs (the old /status + /ctx union)', () => {
    const out = JSON.stringify(
      statusCard(statusFixture({ agentName: 'OMP', wsNames: ['bridge', 'notes'] })),
    );
    expect(out).toContain('🤖 OMP');
    expect(out).toContain('bridge');
    expect(out).toContain('notes');
  });

  it('warns when the session belongs to an old cwd', () => {
    const out = JSON.stringify(statusCard(statusFixture({ sessionStale: true })));
    expect(out).toContain('旧 cwd');
  });

  it('reports the session id as a single identity line (no segment layer)', () => {
    const out = JSON.stringify(
      statusCard(
        statusFixture({
          sessionId: 'ws-first',
        }),
      ),
    );
    expect(out).toContain('会话');
    expect(out).toContain('`ws-first`');
  });

  it('is informational — no action buttons', () => {
    const out = JSON.stringify(statusCard(statusFixture()));
    // The four quick actions were noise: every one of them is a typed command
    // documented in /help, and /help is the card that carries the shortcuts.
    expect(out).not.toContain('"tag":"button"');
    for (const cmd of ['new', 'resume', 'ws.list', 'help']) {
      expect(out).not.toContain(`"cmd":"${cmd}"`);
    }
    // No dangling divider where the button row used to be.
    expect(out).not.toContain('"tag":"hr"');
  });
});

describe('session id rendering', () => {
  const ULID = '01J8Z9K2ABCDEFGHJKLMNPQRST';

  it('shows the full session id on the merged status card', () => {
    const out = JSON.stringify(
      statusCard(
        statusFixture({ sessionId: ULID, sessionName: '长 id 会话', agentName: 'OMP' }),
      ),
    );
    expect(out).toContain(ULID);
    // No truncated form leaks through.
    expect(out).not.toContain('01J8Z9K2…');
  });

  it('shows the full id on the singular /resume confirmation card', () => {
    const saved = resumeSavedCard(ULID, '/repo/sub');
    const out = JSON.stringify(saved);
    expect(out).toContain(ULID);
    // 恢复确认卡里的 id 是完整可复制的（列表行才用 8 字符句柄）。
    expect(out).not.toContain('01J8Z9K2…');
  });
});

/** help 卡：元素 0 是标题，之后每个分组一个 collapsible_panel。 */
interface HelpPanelCard {
  body: {
    elements: Array<{
      tag: string;
      expanded?: boolean;
      header: { title: { content: string } };
      elements?: Array<{ content?: string }>;
    }>;
  };
}

describe('helpCard', () => {
  it('groups commands into collapsible category panels', () => {
    const card = helpCard();
    const out = JSON.stringify(card);
    expect(out).toContain('会话管理');
    expect(out).toContain('偏好设置');
    expect(out).toContain('工作空间');
    expect(out).toContain('运行控制');
    expect(out).toContain('进程与诊断');
    // Every previously documented command survives the regrouping.
    for (const cmd of [
      '/new',
      '/resume',
      '/rename',
      '/config',
      '/timeout',
      '/model',
      '/thinking',
      '/think',
      '/account',
      '/cd',
      '/ws',
      '/stop',
      '/reconnect',
      '/restart',
      '/ps',
      '/exit',
      '/doctor',
      '/exec',
      '/release',
      '/search',
      '/context',
      '/status',
      '/session',
      '/diff',
      '/every',
    ]) {
      expect(out).toContain(cmd);
    }
    // One collapsible panel per category.
    expect(out.match(/"tag":"collapsible_panel"/g)).toHaveLength(5);
    expect(out.match(/"expanded":(true|false)/g)).toHaveLength(5);
  });

  it('默认展开「会话管理」与「运行控制」，其余分组保持折叠', () => {
    const card = helpCard();
    const out = JSON.stringify(card);
    // 全折叠时 /help 只剩 5 行标题，用户看不到任何命令 —— 至少这两组要摊开。
    expect(out.match(/"expanded":true/g)).toHaveLength(2);
    expect(out.match(/"expanded":false/g)).toHaveLength(3);

    const card2 = helpCard() as HelpPanelCard;
    const panels = card2.body.elements.filter((el) => el.tag === 'collapsible_panel');
    const expandedTitles = panels
      .filter((el) => el.expanded === true)
      .map((el) => el.header.title.content);
    expect(expandedTitles).toHaveLength(2);
    expect(expandedTitles.some((t) => t.includes('会话管理'))).toBe(true);
    expect(expandedTitles.some((t) => t.includes('运行控制'))).toBe(true);
    // 默认展开的分组里必须真的看得到命令，否则展开没意义。
    const session = panels.find((el) => el.header.title.content.includes('会话管理'));
    expect(JSON.stringify(session)).toContain('/session');
    const run = panels.find((el) => el.header.title.content.includes('运行控制'));
    expect(JSON.stringify(run)).toContain('/stop');
  });

  it('把 /session /diff /every /think 补进对应分组', () => {
    const card = helpCard() as HelpPanelCard;
    const panels = card.body.elements.filter((el) => el.tag === 'collapsible_panel');
    const groupsOf = (cmd: string) =>
      panels
        .filter((el) => JSON.stringify(el).includes(cmd))
        .map((el) => el.header.title.content);
    expect(groupsOf('/session')).toEqual([expect.stringContaining('会话管理')]);
    expect(groupsOf('/diff')).toEqual([expect.stringContaining('会话管理')]);
    expect(groupsOf('/every')).toEqual([expect.stringContaining('进程与诊断')]);

    const pref = panels.find((el) => el.header.title.content.includes('偏好设置'));
    // `/think` 与 `/thinking` 是同一个 handler：必须落在**同一行**，用户才知道是别名。
    const lines = (pref?.elements?.[0]?.content ?? '').split('\n');
    expect(lines.some((l) => l.includes('/thinking') && l.includes('/think'))).toBe(true);
    expect(
      panels.filter((el) => el.header.title.content.includes('偏好设置')),
    ).toHaveLength(1);
  });
});

describe('workspacesCard', () => {
  it('首态每行是「切换 / 删除」，删除只进入确认态而非直接删', () => {
    const out = JSON.stringify(
      workspacesCard('/repo', { 'proj-a': '/repo', 'proj-b': '/other' }),
    );
    expect(out).toContain('proj-a');
    expect(out).toContain('⭐');
    expect(out).toContain('"cmd":"ws.use","name":"proj-b"');
    // 首次点击只带 removeAsk；真正执行的 ws.remove 只在确认态出现。
    expect(out).toContain('"cmd":"ws.removeAsk","name":"proj-b"');
    expect(out).not.toContain('"cmd":"ws.remove"');
  });

  it('删除确认态给出确认行：确认按钮的 value 与首次点击不同', () => {
    const out = JSON.stringify(
      workspacesCard('/repo', { 'proj-a': '/repo', 'proj-b': '/other' }, 'proj-b'),
    );
    // 确认按钮带真正的执行 cmd，且指向同一个工作空间。
    expect(out).toContain('"cmd":"ws.remove","name":"proj-b"');
    // 该行不再渲染首态的 removeAsk（换成了确认行）。
    expect(out).not.toContain('"cmd":"ws.removeAsk","name":"proj-b"');
    // 未确认的另一行仍是首态。
    expect(out).toContain('"cmd":"ws.removeAsk","name":"proj-a"');
    // 退路「取消」把卡换回普通列表。
    expect(out).toContain('"cmd":"ws.list"');
    expect(out).toContain('确认删除工作空间');
  });

  it('shows the empty-state hint', () => {
    const out = JSON.stringify(workspacesCard(undefined, {}));
    expect(out).toContain('暂无命名工作空间');
    expect(out).toContain('/ws save');
  });

  it('空态给出一键保存的推进动作，不再只有 ws.cancel', () => {
    // 有 cwd + 命令层给了建议名：按钮直接用该名字保存。
    const withCwd = JSON.stringify(workspacesCard('/home/me/proj', {}, undefined, 'proj'));
    expect(withCwd).toContain('"cmd":"ws.save","name":"proj"');
    expect(withCwd).not.toContain('"cmd":"ws.cancel"');
    // 命令层没给名字时，卡片不自己推导（不 import node:path），按钮仍给出下一步。
    const noName = JSON.stringify(workspacesCard('/home/me/proj', {}));
    expect(noName).toContain('"cmd":"ws.save"');
    expect(noName).not.toContain('"name"');
    // 没有 cwd：仍有一个推进按钮（引导下一步），不留死路。
    const noCwd = JSON.stringify(workspacesCard(undefined, {}));
    expect(noCwd).toContain('"cmd":"ws.save"');
    expect(noCwd).not.toContain('"cmd":"ws.cancel"');
  });
});

describe('statusCard — 最近内容 / 工作空间 / 占位（原 /context 的能力）', () => {
  const base: ContextInfo = {
    scope: 'oc_1',
    chatMode: 'p2p',
    cwd: '/repo',
    sessionId: '019f3a2b-7c8d-73e1-9f2a-4b5c6d7e8f90',
    sessionName: '修搜索',
    createdAt: Date.now() - 86_400_000,
    updatedAt: Date.now() - 120_000,
    running: false,
    agentName: 'OMP',
    model: 'p/m',
    thinking: 'high',
    idleLine: '全局 30 分钟',
    wsNames: ['bridge'],
    summary: { lastMessage: '你好  abc', lastReply: '答完了' },
  };

  it('renders the panels with agent, workspace quick-dirs and digested recent content', () => {
    const out = JSON.stringify(statusCard(base));
    expect(out).toContain('会话');
    expect(out).toContain('环境');
    expect(out).toContain('最近内容');
    expect(out).toContain('修搜索');
    expect(out).toContain('019f3a2b-7c8d-73e1-9f2a-4b5c6d7e8f90');
    expect(out).toContain('你好 abc');
    expect(out).toContain('答完了');
    expect(out).toContain('bridge');
    expect(out).toContain('全局 30 分钟');
  });

  it('carries no action buttons — it is informational', () => {
    const out = JSON.stringify(statusCard(base));
    expect(out).not.toContain('"tag":"button"');
    expect(out).not.toContain('"cmd":"status"');
    expect(out).not.toContain('"cmd":"resume"');
  });

  it('stacks the panels full-width instead of laying them side by side', () => {
    const out = statusCard(base) as { body: { elements: Array<Record<string, unknown>> } };
    const sets = out.body.elements.filter((e) => e.tag === 'column_set');
    // One single-column column_set per panel — stacked at every card width,
    // unlike a multi-column row that goes side by side on a desktop card.
    expect(sets).toHaveLength(3);
    for (const set of sets) {
      expect((set.columns as unknown[])).toHaveLength(1);
    }
    expect(JSON.stringify(out)).not.toContain('"flex_mode":"stretch"');
  });

  it('drops the recent panel and placeholders when nothing to show', () => {
    const out = JSON.stringify(
      statusCard({
        ...base,
        sessionId: undefined,
        sessionName: undefined,
        createdAt: undefined,
        updatedAt: undefined,
        model: undefined,
        thinking: undefined,
        wsNames: [],
        summary: {},
      }),
    );
    expect(out).not.toContain('最近内容');
    // 没名字 → 没有标题行（也不拿占位冒充）。
    expect(out).not.toContain('未命名');
    expect(out).not.toContain('🏷');
    expect(out).toContain('跟随默认');
    expect(out).toContain('（当前目录无快捷方式）');
  });
});

describe('cwdChangedCard', () => {
  it('renders the new cwd with workspace and status shortcuts', () => {
    const out = JSON.stringify(cwdChangedCard('/repo/src'));
    expect(out).toContain('已切换工作目录');
    expect(out).toContain('/repo/src');
    expect(out).toContain('session 已重置');
    expect(out).toContain('"cmd":"ws.list"');
    expect(out).toContain('"cmd":"status"');
  });

  it('carries the topic scope note when provided', () => {
    const out = JSON.stringify(cwdChangedCard('/repo/src', '话题独立会话'));
    expect(out).toContain('话题独立会话');
  });
});

describe('newSessionCard', () => {
  it('renders a compact confirmation without the full context dump', () => {
    const card = newSessionCard({
      cwd: '/repo',
      model: 'p/m',
      thinking: 'high',
      idleLine: '全局 30 分钟',
      wasRunning: true,
    });
    const out = JSON.stringify(card);
    expect(card).toMatchObject({ schema: '2.0' });
    expect(out).toContain('已中断当前任务并重置上下文');
    expect(out).toContain('/repo');
    expect(out).toContain('p/m');
    expect(out).toContain('high');
    expect(out).toContain('全局 30 分钟');
    // 不再整段渲染 /context：不应出现占位字段
    expect(out).not.toContain('开始对话');
    expect(out).not.toContain('最后对话');
  });

  it('marks a clean start when nothing was running', () => {
    const out = JSON.stringify(
      newSessionCard({
        cwd: '/repo',
        idleLine: '未启用（不自动中断任务）',
        wasRunning: false,
      }),
    );
    expect(out).not.toContain('已中断');
    expect(out).toContain('已重置上下文');
  });

  it('carries the topic scope note when provided', () => {
    const out = JSON.stringify(
      newSessionCard({
        cwd: '/repo',
        idleLine: '全局 30 分钟',
        wasRunning: false,
        scopeNote: '话题独立会话',
      }),
    );
    expect(out).toContain('话题独立会话');
  });
});

describe('onlineCard', () => {
  it('announces the boot with heading and note, no buttons', () => {
    const out = JSON.stringify(onlineCard());
    expect(out).toContain('已上线');
    expect(out).toContain('服务已重新启动');
    expect(out).not.toContain('"button"');
    expect(out).not.toContain('column');
  });

  it('附上调用方给的重启原因行（卡片只负责转义渲染）', () => {
    const out = JSON.stringify(onlineCard('原因：手动启动。'));
    expect(out).toContain('原因：手动启动。');
  });
});

describe('timeoutCard', () => {
  it('当前值两行 + 四个动作按钮的 payload', () => {
    const out = JSON.stringify(
      timeoutCard({ current: '当前 session 探活：30 分钟', global: '全局默认：60 分钟' }),
    );
    expect(out).toContain('当前 session 探活：30 分钟');
    expect(out).toContain('全局默认：60 分钟');
    expect(out).toContain('"cmd":"timeout","arg":"15"');
    expect(out).toContain('"cmd":"timeout","arg":"30"');
    expect(out).toContain('"cmd":"timeout","arg":"off"');
    expect(out).toContain('"cmd":"timeout","arg":"default"');
  });

  it('notice 转义后原样回显（错误值里带 markdown 也不破卡）', () => {
    const card = timeoutCard({ current: 'a', global: 'b', notice: '**1e3**' }) as {
      body: { elements: Array<{ content?: string }> };
    };
    const noticeEl = card.body.elements.find((el) => el.content?.includes('1e3'));
    expect(noticeEl?.content).toBe('\\*\\*1e3\\*\\*');
  });

  it('cancelled 终态不再渲染任何动作按钮', () => {
    const out = JSON.stringify(timeoutCard({ current: 'a', global: 'b', cancelled: true }));
    expect(out).toContain('已取消操作');
    expect(out).not.toContain('"cmd":"timeout"');
  });
});

describe('compactCard 取消入口', () => {
  it('started 卡带「取消压缩」按钮，payload 复用 /stop', () => {
    const out = JSON.stringify(compactCard({ phase: 'started' }));
    expect(out).toContain('取消压缩');
    expect(out).toContain('"cmd":"stop"');
  });
});

describe('releaseCard / restartCard 排空超时', () => {
  it('release 的超时态写明「超时」与中断数量，时限仍来自调用方', () => {
    const out = JSON.stringify(
      releaseCard({
        steps: [],
        phase: 'restarting',
        drain: { runningCount: 2, timeoutMs: 5 * 60_000, timedOut: true },
      }),
    );
    expect(out).toContain('超时');
    expect(out).toContain('2 个在跑任务被中断');
    // 每一处时限都由「最多」引出（没有另外硬编码的时间）。
    const caps = out.match(/最多 \d+ 分钟/g) ?? [];
    const mins = out.match(/\d+ 分钟/g) ?? [];
    expect(mins.length).toBeGreaterThan(0);
    expect(mins.length).toBe(caps.length);
  });

  it('restart 的 draining 超时变体说清强杀与中断数量', () => {
    const out = JSON.stringify(
      restartCard('draining', undefined, {
        runningCount: 3,
        timeoutMs: 5 * 60_000,
        timedOut: true,
      }),
    );
    expect(out).toContain('超时');
    expect(out).toContain('3 个在跑任务被中断');
  });
});

describe('releaseCard restarting phase', () => {
  it('announces the bounce without claiming success', () => {
    const out = JSON.stringify(releaseCard({ steps: [], phase: 'restarting' }));
    expect(out).toContain('构建完成，正在重启加载新产物');
    expect(out).toContain('新进程启动后会确认上线');
    expect(out).not.toContain('已发布上线');
  });

  it('claims success only in the success phase', () => {
    expect(JSON.stringify(releaseCard({ steps: [], phase: 'success' }))).toContain('已发布上线');
  });
});

describe('releaseCard empty steps', () => {
  it('omits the panel entirely instead of rendering an empty grey box', () => {
    const card = releaseCard({ steps: [], phase: 'success' });
    const json = JSON.stringify(card);
    expect(json).toContain('已发布上线');
    expect(json).not.toContain('"elements":[]');
    // 无步骤时不应出现 column_set（空 column 会渲染成空灰框）。
    expect(json).not.toContain('column_set');
  });

  it('keeps the panel when steps exist', () => {
    const json = JSON.stringify(
      releaseCard({ steps: [{ name: 'build', status: 'ok' }], phase: 'success' }),
    );
    expect(json).toContain('column_set');
    expect(json).toContain('✅ 构建');
  });
});
