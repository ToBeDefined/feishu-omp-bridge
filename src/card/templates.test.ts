import { describe, expect, it } from 'vitest';
import { resumeCard, type ResumeOption } from './model-card';
import type { RunCard } from './run-renderer';
import {
  actions,
  compactCard,
  contextCard,
  cwdChangedCard,
  everyCard,
  execResultCard,
  helpCard,
  md,
  newSessionCard,
  panel,
  psCard,
  releaseCard,
  shell,
  statusCard,
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
    expect(out).toContain('○ 构建');
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
    expect(out).toContain('正在重启加载新代码');
  });
});

describe('compactCard', () => {
  it('shows the size estimate while running', () => {
    const out = JSON.stringify(
      compactCard({ phase: 'started', tokensK: '690', mb: '10.0', eta: '15分30秒', cap: '46分' }),
    );
    expect(out).toContain('正在压缩会话上下文');
    expect(out).toContain('690k token');
    expect(out).toContain('10.0 MB');
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
      execResultCard({ cmd: 'pnpm test', exitCode: 0, output: 'all green', timedOut: false, timeoutSeconds: 30 }),
    );
    expect(out).toContain('命令执行完成');
    expect(out).toContain('$ pnpm test');
    expect(out).toContain('"expanded":false');
    expect(out).toContain('all green');
  });

  it('expands output and marks failure on non-zero exit', () => {
    const out = JSON.stringify(
      execResultCard({ cmd: 'boom', exitCode: 2, output: 'err', timedOut: false, timeoutSeconds: 30 }),
    );
    expect(out).toContain('命令失败**（退出码 2）');
    expect(out).toContain('"expanded":true');
    expect(out).toContain('"color":"red"');
  });

  it('marks timeouts and empty output', () => {
    const out = JSON.stringify(
      execResultCard({ cmd: 'sleep 100', exitCode: null, output: '', timedOut: true, timeoutSeconds: 30 }),
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
    expect(actions([{ text: 'go', value: { cmd: 'x' } }])).toMatchObject({
      tag: 'column_set',
    });
  });
});

function statusFixture(extra: Partial<Parameters<typeof statusCard>[0]> = {}) {
  return {
    cwd: '/repo',
    sessionId: 's1',
    sessionStale: false,
    agentName: 'omp',
    scope: 'oc_1',
    chatMode: 'p2p' as const,
    idleLine: '全局 30 分钟',
    running: false,
    ...extra,
  };
}

describe('statusCard', () => {
  it('shows the session title when set', () => {
    const withTitle = JSON.stringify(
      statusCard(statusFixture({ sessionTitle: '修搜索' })),
    );
    expect(withTitle).toContain('修搜索');

    const without = JSON.stringify(statusCard(statusFixture()));
    expect(without).not.toContain('标题');
  });

  it('renders as a schema 2.0 card with session and environment panels', () => {
    const card = statusCard(
      statusFixture({
        model: 'zhipu-coding-plan/glm-5.3',
        thinking: 'high',
        lastActive: Date.now() - 5 * 60_000,
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

  it('warns when the session belongs to an old cwd', () => {
    const out = JSON.stringify(statusCard(statusFixture({ sessionStale: true })));
    expect(out).toContain('旧 cwd');
  });

  it('keeps the quick actions, including one-click resume', () => {
    const out = JSON.stringify(statusCard(statusFixture()));
    expect(out).toContain('"cmd":"new"');
    expect(out).toContain('"cmd":"resume"');
    expect(out).toContain('"cmd":"ws.list"');
    expect(out).toContain('"cmd":"help"');
  });
});

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
    ]) {
      expect(out).toContain(cmd);
    }
    // One collapsible panel per category, all collapsed by default.
    expect(out.match(/"tag":"collapsible_panel"/g)).toHaveLength(5);
    expect(out.match(/"expanded":false/g)?.length).toBeGreaterThanOrEqual(5);
  });
});

describe('workspacesCard', () => {
  it('marks the current workspace and keeps switch/remove actions per row', () => {
    const out = JSON.stringify(
      workspacesCard('/repo', { 'proj-a': '/repo', 'proj-b': '/other' }),
    );
    expect(out).toContain('proj-a');
    expect(out).toContain('⭐');
    expect(out).toContain('"cmd":"ws.use","name":"proj-b"');
    expect(out).toContain('"cmd":"ws.remove","name":"proj-b"');
  });

  it('shows the empty-state hint', () => {
    const out = JSON.stringify(workspacesCard(undefined, {}));
    expect(out).toContain('暂无命名工作空间');
    expect(out).toContain('/ws save');
  });
});

describe('contextCard', () => {
  const base = {
    scope: 'oc_1',
    chatMode: 'p2p' as const,
    cwd: '/repo',
    sessionId: '019f3a2b-7c8d-73e1-9f2a-4b5c6d7e8f90',
    sessionTitle: '修搜索',
    createdAt: Date.now() - 86_400_000,
    updatedAt: Date.now() - 120_000,
    running: false,
    model: 'p/m',
    thinking: 'high',
    idleLine: '全局 30 分钟',
    wsNames: ['bridge'],
    summary: { lastMessage: '你好  abc', lastReply: '答完了' },
  };

  it('renders the three panels with digested recent content', () => {
    const out = JSON.stringify(contextCard(base));
    expect(out).toContain('会话');
    expect(out).toContain('环境');
    expect(out).toContain('最近内容');
    expect(out).toContain('修搜索');
    expect(out).toContain('019f3a2b…');
    expect(out).toContain('你好 abc');
    expect(out).toContain('答完了');
    expect(out).toContain('bridge');
    expect(out).toContain('全局 30 分钟');
  });

  it('drops the recent panel and placeholders when nothing to show', () => {
    const out = JSON.stringify(
      contextCard({
        ...base,
        sessionId: undefined,
        sessionTitle: undefined,
        createdAt: undefined,
        updatedAt: undefined,
        model: undefined,
        thinking: undefined,
        wsNames: [],
        summary: {},
      }),
    );
    expect(out).not.toContain('最近内容');
    expect(out).toContain('未命名');
    expect(out).toContain('跟随默认');
    expect(out).toContain('（当前目录无快捷方式）');
  });
});

describe('resumeCard', () => {
  it('shows the title ahead of the summary', () => {
    const sessions: ResumeOption[] = [
      { sessionId: 's1', cwd: '/repo', timestamp: 't', title: '已命名', summary: '旧摘要' },
      { sessionId: 's2', cwd: '/repo2', timestamp: 't2', summary: '摘要B' },
    ];
    const out = JSON.stringify(resumeCard('s1', sessions));

    // Titled session shows its title; the untitled one leads with its summary.
    expect(out).toContain('🏷 **已命名**');
    expect(out).toContain('摘要B');
    // Exactly one titled row — s2 stays unlabeled.
    expect((out.match(/🏷/g) ?? []).length).toBe(1);
  });

  it('renders a relative time from the session timestamp', () => {
    const sessions: ResumeOption[] = [
      {
        sessionId: 's1',
        cwd: '/repo',
        timestamp: new Date(Date.now() - 3 * 60_000).toISOString(),
        summary: '摘要',
      },
    ];
    const out = JSON.stringify(resumeCard('s1', sessions));
    expect(out).toContain('3 分钟前');
    // Untitled + summary → the summary is the row identity.
    expect(out).toContain('**摘要**');
  });

  it('marks the current session and keeps full ids in button values', () => {
    const sessions: ResumeOption[] = [
      { sessionId: 's1', cwd: '/repo', timestamp: 't', title: 'A' },
      { sessionId: 's2', cwd: '/repo', timestamp: 't', title: 'B' },
    ];
    const out = JSON.stringify(resumeCard('s1', sessions));
    expect(out).toContain('✓ 当前');
    expect(out).toContain('"arg":"s1"');
    expect(out).toContain('"arg":"s2"');
  });

  it('keeps pagination range and older/newer navigation', () => {
    const page: ResumeOption[] = Array.from({ length: 5 }, (_, i) => ({
      sessionId: `s${i}`,
      cwd: '/repo',
      timestamp: 't',
    }));
    const out = JSON.stringify(resumeCard(undefined, page, { offset: 5, total: 12 }));
    expect(out).toContain('第 6-10 条 / 共 12 条');
    expect(out).toContain('"cmd":"resume.back","arg":"0"');
    expect(out).toContain('"cmd":"resume.more","arg":"10"');
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
    expect(out).toContain('已中断当前任务并开始新会话');
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
    expect(out).toContain('已开始新会话');
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
