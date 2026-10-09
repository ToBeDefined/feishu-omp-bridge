import { homedir } from 'node:os';
import type { ContextInfo } from '../commands/session/context';
import { formatAgoOr, formatClockOr } from '../utils/time';

interface ButtonSpec {
  text: string;
  value: Record<string, unknown>;
  style?: 'primary' | 'danger' | 'default';
}

function button(spec: ButtonSpec): object {
  return {
    tag: 'button',
    text: { tag: 'plain_text', content: spec.text },
    type: spec.style ?? 'default',
    value: spec.value,
  };
}

/** JSON 2.0 markdown element; `size` shrinks ('notation') or enlarges ('heading'). */
export function md(content: string, size?: 'heading' | 'notation'): object {
  return size === undefined
    ? { tag: 'markdown', content }
    : { tag: 'markdown', content, text_size: size };
}

export function actions(buttons: ButtonSpec[]): object {
  // Schema 2.0 has no `action` container — buttons ride in a column_set row.
  return {
    tag: 'column_set',
    flex_mode: 'none',
    horizontal_spacing: 'small',
    columns: buttons.map((spec) => ({
      tag: 'column',
      width: 'auto',
      vertical_align: 'center',
      elements: [button(spec)],
    })),
  };
}

const HR: object = { tag: 'hr' };

interface PanelOpts {
  title: string;
  expanded: boolean;
  border: 'grey' | 'red' | 'blue';
  /** Markdown body — ignored when `elements` is provided. */
  body?: string;
  /** Prebuilt panel elements — overrides `body` (used for nested panels). */
  elements?: object[];
}

/** Collapsed-by-default ▸ panel; expanding rotates the arrow to ▾. */
export function collapsiblePanel(opts: PanelOpts): object {
  return {
    tag: 'collapsible_panel',
    expanded: opts.expanded,
    header: {
      title: { tag: 'markdown', content: opts.title },
      vertical_align: 'center',
      icon: { tag: 'standard_icon', token: 'right-small-ccm_outlined', size: '16px 16px' },
      icon_position: 'follow_text',
      icon_expanded_angle: 90,
    },
    border: { color: opts.border, corner_radius: '5px' },
    vertical_spacing: '8px',
    padding: '8px 8px 8px 8px',
    elements:
      opts.elements ?? [{ tag: 'markdown', content: opts.body, text_size: 'notation' }],
  };
}

/** Collapsed, markdown-safe one-line digest of user/assistant content. */
function digest(text: string, max = 80): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return escapeMd(flat.length > max ? `${flat.slice(0, max)}…` : flat);
}

/** Schema 2.0 card shell: `summary` is the notification/condensed preview. */
export function shell(summary: string, elements: object[]): object {
  return {
    schema: '2.0',
    config: { summary: { content: summary } },
    body: { elements },
  };
}

/** Grey info panel column (the rounded stat-card look). */
export function panel(elements: object[]): object {
  return {
    tag: 'column',
    width: 'weighted',
    weight: 1,
    background_style: 'grey',
    padding: '8px',
    vertical_align: 'top',
    elements,
  };
}

/** Collapse $HOME to `~` so cwd/session paths stay readable in cards. */
export function tildePath(p: string): string {
  const home = homedir();
  return p.startsWith(home) ? `~${p.slice(home.length)}` : p;
}

/** `tildePath` + keep only the last 24 chars — for tight meta lines. */
export function shortPath(p: string): string {
  const rel = tildePath(p);
  return rel.length > 24 ? `…${rel.slice(-24)}` : rel;
}

export function workspacesCard(current: string | undefined, named: Record<string, string>): object {
  const entries = Object.entries(named);
  const elements: object[] = [];

  elements.push(md(`📂 **工作空间**`, 'heading'));
  elements.push(md(`当前 cwd：\`${escapeCode(tildePath(current ?? '(未设置，使用 $HOME)'))}\``));

  if (entries.length === 0) {
    elements.push(HR);
    elements.push(md('暂无命名工作空间。'));
    elements.push(md('_💡 发送 `/ws save <name>` 把当前 cwd 存为命名工作空间_', 'notation'));
  } else {
    elements.push(HR);
    entries.forEach(([name, path], i) => {
      const isCurrent = path === current;
      elements.push({
        tag: 'column_set',
        flex_mode: 'none',
        horizontal_spacing: 'small',
        columns: [
          {
            tag: 'column',
            width: 'weighted',
            weight: 1,
            vertical_align: 'center',
            elements: [
              md(`**${escapeMd(name)}**${isCurrent ? ' ⭐' : ''}`),
              md(`_${escapeCode(tildePath(path))}_`, 'notation'),
            ],
          },
          {
            tag: 'column',
            width: 'auto',
            vertical_align: 'center',
            elements: [button({ text: '切换', value: { cmd: 'ws.use', name }, style: 'primary' })],
          },
          {
            tag: 'column',
            width: 'auto',
            vertical_align: 'center',
            elements: [button({ text: '删除', value: { cmd: 'ws.remove', name }, style: 'danger' })],
          },
        ],
      });
      if (i < entries.length - 1) elements.push(HR);
    });
  }

  elements.push(HR);
  elements.push(actions([{ text: '取消', value: { cmd: 'ws.cancel' } }]));

  return shell('📂 工作空间', elements);
}

export interface StatusInfo {
  cwd: string;
  sessionId?: string;
  /** User-assigned session title (/rename), if any. */
  sessionTitle?: string;
  sessionStale: boolean;
  agentName: string;
  /** Session scope (= chatId or chatId:threadId in topic groups). */
  scope: string;
  /** Chat mode — used to label scope. */
  chatMode: 'p2p' | 'group' | 'topic';
  /** Active model selector; absent = following OMP default. */
  model?: string;
  /** Thinking level; absent = following OMP default. */
  thinking?: string;
  /** Rendered idle-timeout line (scope override vs global default). */
  idleLine: string;
  createdAt?: number;
  lastActive?: number;
  /** Whether a run is executing in this scope right now. */
  running: boolean;
}

/** First 8 chars of a session id — enough for `/resume <prefix>` matching. */
function shortId(id: string): string {
  return id.length > 8 ? `${id.slice(0, 8)}…` : id;
}

export function statusCard(info: StatusInfo): object {
  const scopeLine =
    info.chatMode === 'topic'
      ? `窗口 \`${escapeCode(info.scope)}\` _（话题独立会话）_`
      : `窗口 \`${escapeCode(info.scope)}\``;

  const sessionPanel = [
    md('**🗂 会话**'),
    md(
      info.sessionTitle
        ? `🏷 ${escapeMd(info.sessionTitle)}`
        : '🏷 _未命名_',
    ),
    md(
      info.sessionId
        ? `🔗 \`${escapeCode(shortId(info.sessionId))}\``
        : '🔗 _无，下条消息新建_',
    ),
    md(`🕒 ${formatClockOr(info.createdAt, '—')}`),
    md(`🕘 ${formatAgoOr(info.lastActive, '新会话')}`),
    md(info.running ? '🔄 任务执行中' : '✅ 空闲'),
  ];
  const envPanel = [
    md('**🧩 环境**'),
    md(`📁 \`${escapeCode(tildePath(info.cwd))}\``),
    md(`🤖 ${escapeMd(info.agentName)}`),
    md(`🎛 ${info.model ? `\`${escapeCode(info.model)}\`` : '_跟随默认_'}`),
    md(`💭 ${info.thinking ? `\`${escapeCode(info.thinking)}\`` : '_跟随默认_'}`),
    md(`⏱ ${escapeMd(info.idleLine)}`),
  ];

  return shell('📊 会话状态', [
    md('📊 **会话状态**', 'heading'),
    md(scopeLine, 'notation'),
    {
      tag: 'column_set',
      // stretch: panels stack vertically on narrow (mobile) screens instead
      // of squeezing side by side.
      flex_mode: 'stretch',
      horizontal_spacing: 'small',
      columns: [panel(sessionPanel), panel(envPanel)],
    },
    ...(info.sessionStale
      ? [md('⚠️ _session 来自旧 cwd，下一条消息将新建会话_', 'notation')]
      : []),
    HR,
    actions([
      { text: '🆕 新会话', value: { cmd: 'new' }, style: 'primary' },
      { text: '🕘 恢复会话', value: { cmd: 'resume' } },
      { text: '📂 工作空间', value: { cmd: 'ws.list' } },
      { text: '💡 帮助', value: { cmd: 'help' } },
    ]),
  ]);
}

/** /cd success card: the new cwd, the session-reset consequence, and the
 * two most likely follow-ups (workspace list, status). */
export function cwdChangedCard(cwd: string): object {
  return shell('📁 已切换工作目录', [
    md('📁 **已切换工作目录**', 'heading'),
    md(`新的 cwd：\`${escapeCode(tildePath(cwd))}\``),
    md('_session 已重置，下一条消息在新目录开始。_', 'notation'),
    { tag: 'hr' },
    actions([
      { text: '📂 工作空间', value: { cmd: 'ws.list' } },
      { text: '📊 状态', value: { cmd: 'status' } },
    ]),
  ]);
}

/** /context card — same data as the /status panels plus the recent
 * message/reply digest, from the shared ContextInfo gatherer
 * (commands/session/context.ts). Type-only import: no runtime cycle. */
export function contextCard(
  info: ContextInfo,
): object {
  const hasRecent = Boolean(info.summary.lastMessage || info.summary.lastReply);
  const recentPanel = hasRecent
    ? [
        panel([
          md('**💬 最近内容**'),
          ...(info.summary.lastMessage
            ? [md(`💬 ${digest(info.summary.lastMessage, 80)}`)]
            : []),
          ...(info.summary.lastReply
            ? [md(`📝 ${digest(info.summary.lastReply, 80)}`)]
            : []),
        ]),
      ]
    : [];
  const scopeLine =
    info.chatMode === 'topic'
      ? `窗口 \`${escapeCode(info.scope)}\` _（话题独立会话）_`
      : `窗口 \`${escapeCode(info.scope)}\``;
  const wsLine =
    info.wsNames.length > 0
      ? info.wsNames.map((n) => `\`${escapeCode(n)}\``).join(' ')
      : '_（当前目录无快捷方式）_';
  return shell('🧾 会话上下文', [
    md('🧾 **会话上下文**', 'heading'),
    md(scopeLine, 'notation'),
    {
      tag: 'column_set',
      flex_mode: 'stretch',
      horizontal_spacing: 'small',
      columns: [
        panel([
          md('**🗂 会话**'),
          md(info.sessionTitle ? `🏷 ${escapeMd(info.sessionTitle)}` : '🏷 _未命名_'),
          md(
            info.sessionId
              ? `🔗 \`${escapeCode(shortId(info.sessionId))}\``
              : '🔗 _无，下条消息新建_',
          ),
          md(`🕒 ${formatClockOr(info.createdAt, '—')}`),
          md(`🕘 ${formatAgoOr(info.updatedAt, '新会话')}`),
          md(info.running ? '🔄 任务执行中' : '✅ 空闲'),
        ]),
        panel([
          md('**🧩 环境**'),
          md(`📁 \`${escapeCode(tildePath(info.cwd))}\``),
          md(`🎛 ${info.model ? `\`${escapeCode(info.model)}\`` : '_跟随默认_'}`),
          md(`💭 ${info.thinking ? `\`${escapeCode(info.thinking)}\`` : '_跟随默认_'}`),
          md(`⏱ ${escapeMd(info.idleLine)}`),
          md(`📂 ${wsLine}`),
        ]),
        ...recentPanel,
      ],
    },
    { tag: 'hr' },
    actions([
      { text: '📊 状态', value: { cmd: 'status' }, style: 'primary' },
      { text: '🕘 恢复会话', value: { cmd: 'resume' } },
    ]),
  ]);
}

/** /diff card: stat fence up top, the full diff collapsed in one panel. */
export function diffCard(cwd: string, stat: string, diff: string): object {
  const DIFF_MAX = 4000;
  const truncated =
    diff.length > DIFF_MAX
      ? `${diff.slice(0, DIFF_MAX)}\n…（diff 已截断，完整内容看本机）`
      : diff;
  const elements: object[] = [
    md('📦 **git diff**', 'heading'),
    md(`_\`${escapeCode(tildePath(cwd))}\` 工作区未提交改动_`, 'notation'),
  ];
  if (stat) elements.push(md(codeFence(stat)));
  elements.push(
    collapsiblePanel({
      title: '📄 **改动内容**',
      expanded: false,
      border: 'grey',
      body: codeFence(truncated, 'diff'),
    }),
  );
  if (diff.length > DIFF_MAX) {
    elements.push(noteMd('_⚠️ diff 已截断_'));
  }
  return shell('📦 git diff', elements);
}

const HELP_GROUPS: Array<{ title: string; items: Array<[string, string]> }> = [
  {
    title: '🗂 会话管理',
    items: [
      ['/new · /reset', '清空当前会话，从零开始'],
      ['/new chat [名字]', '新建群 + 新会话，自动拉你进群'],
      ['/resume', '历史会话列表，一键恢复'],
      ['/rename <标题>', '会话命名；`auto` LLM 生成，`clear` 清除'],
      ['/status', '当前会话 / 环境状态卡片'],
      ['/context · /ctx', '会话上下文详情'],
      ['/search <关键词> · /s', '跨会话历史检索'],
    ],
  },
  {
    title: '🎛 偏好设置',
    items: [
      ['/config', '回复方式、工具调用显示等偏好'],
      ['/timeout [N|off|default]', '当前会话探活分钟数'],
      ['/model [id|reset]', '查看 / 切换模型'],
      ['/thinking [level|reset]', '思考强度（off~max）'],
      ['/account', '查看 / 更换应用凭据并重连'],
    ],
  },
  {
    title: '📂 工作空间',
    items: [
      ['/cd <路径>', '切换工作目录（会重置 session）'],
      ['/ws list|save|use|remove', '命名工作空间管理'],
    ],
  },
  {
    title: '⏯ 运行控制',
    items: [
      ['/stop', '终止当前任务（等同卡片 ⏹ 按钮）'],
      ['/reconnect', '强制重连 WebSocket'],
      ['/restart', '重启当前 bot（launchd 拉起新实例）'],
    ],
  },
  {
    title: '🩺 进程与诊断',
    items: [
      ['/ps', '列出本机 bot，标识当前回复者'],
      ['/exit <id|#>', '关闭指定 bot'],
      ['/doctor [描述]', '日志 + 描述交给 OMP 自助诊断'],
      ['/exec <命令> · /run', '在当前 cwd 执行 shell（admin）'],
      ['/release', '自发布：typecheck→test→build→重启'],
    ],
  },
];

export interface NewSessionInfo {
  cwd: string;
  model?: string;
  thinking?: string;
  idleLine: string;
  wasRunning: boolean;
}

/** Compact /new confirmation — deliberately NOT the full /context dump:
 * a fresh session has nothing to show for 「开始/最后对话」 yet. */
export function newSessionCard(info: NewSessionInfo): object {
  return shell('✅ 新会话已开始', [
    md(
      info.wasRunning
        ? '✅ **已中断当前任务并开始新会话**'
        : '✅ **已开始新会话**',
      'heading',
    ),
    {
      tag: 'column_set',
      flex_mode: 'stretch',
      horizontal_spacing: 'small',
      columns: [
        panel([
          md('**🧩 环境**'),
          md(`📁 \`${escapeCode(tildePath(info.cwd))}\``),
          md(`🎛 ${info.model ? `\`${escapeCode(info.model)}\`` : '_跟随默认_'}`),
          md(`💭 ${info.thinking ? `\`${escapeCode(info.thinking)}\`` : '_跟随默认_'}`),
        ]),
        panel([
          md('**⏱ 探活**'),
          md(escapeMd(info.idleLine)),
          md('_直接发消息即可开始，无需其他操作。_', 'notation'),
        ]),
      ],
    },
  ]);
}

export function helpCard(): object {
  const elements: object[] = [md('💡 **命令速查**', 'heading')];
  HELP_GROUPS.forEach((group, gi) => {
    if (gi > 0) elements.push(HR);
    elements.push(md(`**${group.title}**`));
    for (const [cmd, desc] of group.items) {
      elements.push(md(`\`${cmd}\` — ${desc}`));
    }
  });
  elements.push(HR);
  elements.push(md('_发送 `/help` 随时查看；其他内容直接交给 OMP。_', 'notation'));
  elements.push(
    actions([
      { text: '📊 状态', value: { cmd: 'status' }, style: 'primary' },
      { text: '🕘 恢复会话', value: { cmd: 'resume' } },
      { text: '📂 工作空间', value: { cmd: 'ws.list' } },
    ]),
  );
  return shell('💡 命令速查', elements);
}

export function escapeMd(s: string): string {
  // `[ ] ( ) !` are included so untrusted content cannot forge a link or image
  // (`[x](url)` / `![](url)`) inside card markdown.
  return s.replace(/([*_`\\[\]()!])/g, '\\$1');
}

/**
 * Wrap `content` in a backtick fence longer than the longest backtick run it
 * contains (min 3), so untrusted content cannot close the fence early and
 * spill into the surrounding markdown.
 */
export function codeFence(content: string, lang?: string): string {
  const longest = (content.match(/`+/g) ?? []).reduce((max, run) => Math.max(max, run.length), 0);
  const fence = '`'.repeat(Math.max(3, longest + 1));
  return `${fence}${lang ?? ''}\n${content}\n${fence}`;
}

/**
 * Neutralise content that goes INSIDE an inline code span. Backslash escapes
 * are not processed inside a code span, so `escapeMd` there renders visible
 * backslashes (`src/a\(b\).ts`); the span itself already suppresses markdown,
 * only the delimiter needs handling.
 */
export function escapeCode(s: string): string {
  return s.replace(/`/g, "'");
}
