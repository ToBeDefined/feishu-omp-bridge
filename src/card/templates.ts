import { homedir } from 'node:os';
import type { RunCard } from './run-renderer';
import { formatAgoOr, formatClockOr } from '../utils/time';
import { escapeCode, escapeMd } from '../utils/text';

/** Input for /context renders — gathered by commands/session/context.ts
 * (`collectContextInfo`) and consumed here, so the text renderer and the
 * card cannot drift apart. */
/**
 * 会话状态卡（`/status` · `/context` · `/ctx` 同一个）的全部输入。
 *
 * 两个命令合并后这仍是一张卡：会话 / 环境两面板 + 命名工作空间快捷方式 +
 * 最近内容，再补上原来只在 `/status` 里的 agent 名与「会话目录已失效」告警。
 */
export interface ContextInfo {
  scope: string;
  chatMode: 'p2p' | 'group' | 'topic';
  /** 当前工作目录（= 会话的 cwd，没有会话时退回 scope cwd）。 */
  cwd: string;
  /** 当前会话 id（一个 OMP 会话 = 一个对话）；无会话时缺失。 */
  sessionId?: string;
  /** 显示名：/rename 的名字，回退到最后一条用户消息；都没有则缺失。 */
  sessionName?: string;
  createdAt?: number;
  updatedAt?: number;
  running: boolean;
  /** Agent 适配器显示名（OMP）。 */
  agentName: string;
  model?: string;
  thinking?: string;
  idleLine: string;
  /** Named workspaces pointing at the current cwd. */
  wsNames: string[];
  summary: { lastMessage?: string; lastReply?: string };
  /** 当前会话带着一个已经不可用的 cwd：下一条消息会新建会话。 */
  sessionStale?: boolean;
}

export interface ButtonSpec {
  text: string;
  value: Record<string, unknown>;
  style?: 'primary' | 'danger' | 'default';
}

export function button(spec: ButtonSpec): object {
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

/** 动作行里的一列：元素 + 相对宽度（默认 1）。 */
export interface RowItem {
  element: object;
  /** 相对宽度 —— 长标签（「↓ 下一页（剩 N）」）给 1.6，免得等宽把它挤到折行。 */
  weight?: number;
}

/**
 * 卡片动作布局规则（全站统一）：
 *
 * 1. **同一层级的并列动作等宽并排一行** —— 确认 / 否、保存 / 取消、切换 / 删除、
 *    继续对话 / 详情、上一页 / 下一页：一律 `inlineRow`（`inlineActions` 是它的按钮
 *    spec 版）。**单个动作也走它** —— 一列就是整行宽。
 *    **一行最多 `INLINE_ROW_MAX`（2）个**：手机卡片可用宽度约 300px，三列等宽时
 *    每个按钮只剩 ~100px，中文标签（`📂 工作空间`）会被压到看不见文字 —— 超出的
 *    自动折到下一行（最后一行可能只有一个按钮，那就铺满）。
 * 2. **退路动作「取消」单独一行、铺满整宽，放在并列动作下方** —— 它语义不同
 *    （放弃当前操作），挤在正向动作旁边既容易误点，也把正向动作拽到同一视觉层级：
 *    用 `confirmActions(choices, cancel)` 一步到位。
 * 3. **危险动作（删除 / 退出）排在同一行的最右**。
 *
 * 元素版 `inlineRow` 给表单里的按钮用 —— 表单按钮带 `name` /
 * `form_action_type` / `behaviors`，不是 `ButtonSpec` 那套 value。
 */
/** 并排行最多几个按钮 —— 见上方规则：3 列等宽会把中文标签压到看不见。 */
export const INLINE_ROW_MAX = 2;

export function inlineRow(items: RowItem[]): object[] {
  const rows: object[] = [];
  for (let i = 0; i < items.length; i += INLINE_ROW_MAX) {
    rows.push({
      tag: 'column_set',
      flex_mode: 'none',
      horizontal_spacing: 'small',
      columns: items.slice(i, i + INLINE_ROW_MAX).map((item) => ({
        tag: 'column',
        width: 'weighted',
        weight: item.weight ?? 1,
        vertical_align: 'center',
        elements: [item.element],
      })),
    });
  }
  return rows;
}

/** 并列动作并排 + 退路动作「取消」单独一行铺满（规则 1 + 2 的合成）。 */
export function confirmActions(choices: InlineActionSpec[], cancel?: InlineActionSpec): object[] {
  return [
    ...(choices.length > 0 ? inlineActions(choices) : []),
    ...(cancel !== undefined ? inlineActions([cancel]) : []),
  ];
}


/** 8-char session-id handle. Singular "this is your session" lines show the
 * id in full (26-36 chars); lists need only enough to tell rows apart. */
export function shortSessionId(id: string): string {
  return id.length > 8 ? `${id.slice(0, 8)}…` : id;
}

/**
 * Action buttons side by side in ONE row, equal width.
 *
 * Equal `weighted` columns under `flex_mode: 'none'` stay side by side at every
 * card width, unlike `auto` columns, which compress on narrow screens.
 */
/** `inlineRow` 的按钮 spec 版：按上面的规则并排。 */
export function inlineActions(buttons: InlineActionSpec[]): object[] {
  return inlineRow(
    buttons.map((spec) => ({
      element: button(spec),
      ...(spec.weight !== undefined ? { weight: spec.weight } : {}),
    })),
  );
}

/** A button in an {@link inlineActions} row. */
export interface InlineActionSpec extends ButtonSpec {
  /** Relative column width (default 1). A longer label needs a wider column,
   * otherwise equal thirds make it wrap on a phone. */
  weight?: number;
}

/**
 * Stack info panels one per row, each FULL width.
 *
 * A single multi-column `column_set` (even with `flex_mode: 'stretch'`) lays
 * its columns out side by side whenever the card is wide — i.e. on desktop,
 * where two half-width text panels read worse than the same content flowing
 * down the card. One single-column `column_set` per panel keeps them stacked
 * at every width (a bare `column` outside a `column_set` is rejected by the
 * card API).
 */
export function stackedPanels(panels: object[]): object[] {
  return panels.map((p) => ({ tag: 'column_set', flex_mode: 'none', columns: [p] }));
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
export function shell(summary: string, elements: object[]): RunCard {
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

/**
 * /ws 面板。
 *
 * `confirmRemove` 命中某个工作空间时，该行换成确认行（删除是破坏性动作，单击即删
 * 误点代价太大）——首次点击只带 `ws.removeAsk`，确认按钮才带真正的 `ws.remove`。
 */
export function workspacesCard(
  current: string | undefined,
  named: Record<string, string>,
  confirmRemove?: string,
  /** 空态「存为…」按钮建议的名字，由命令层给（卡片层不做路径推导）。 */
  suggestedName?: string,
): object {
  const entries = Object.entries(named);
  const elements: object[] = [];

  elements.push(md(`📂 **工作空间**`, 'heading'));
  elements.push(md(`当前 cwd：\`${escapeCode(tildePath(current ?? '(未设置，使用 $HOME)'))}\``));

  if (entries.length === 0) {
    elements.push(HR);
    elements.push(md('暂无命名工作空间。'));
    elements.push(md('_💡 也可发送 `/ws save <name>` 自定义名字。_', 'notation'));
    // 空态不能只留一个语义空洞的「取消」：给出一键把当前 cwd 存为工作空间的入口。
    // 有 cwd 时名字取目录名（省去手敲）；没有 cwd 时按钮仍给出下一步引导，不留死路。
    const suggested = suggestedName ?? '';
    elements.push(
      ...inlineActions([
        suggested
          ? {
              text: `📌 存为「${suggested}」`,
              value: { cmd: 'ws.save', name: suggested },
              style: 'primary',
            }
          : { text: '📌 存为工作空间', value: { cmd: 'ws.save' }, style: 'primary' },
      ]),
    );
  } else {
    elements.push(HR);
    entries.forEach(([name, path], i) => {
      const isCurrent = path === current;
      // 一行一个工作空间：内容进灰底块，动作并排贴在块下面（与 /search 结果行同一套）。
      elements.push(
        ...stackedPanels([
          panel([
            md(`**${escapeMd(name)}**${isCurrent ? ' ⭐' : ''}`),
            md(`_${escapeCode(tildePath(path))}_`, 'notation'),
          ]),
        ]),
      );
      if (confirmRemove === name) {
        // 确认行：危险动作 + 退路「取消」各占一行（`confirmActions` 的既有排版）。
        elements.push(
          md(`_⚠️ 确认删除工作空间 \`${escapeCode(name)}\`？只移除快捷方式，不动目录。_`, 'notation'),
          ...confirmActions(
            [{ text: '确认删除', value: { cmd: 'ws.remove', name }, style: 'danger' }],
            { text: '取消', value: { cmd: 'ws.list' } },
          ),
        );
      } else {
        elements.push(
          ...inlineActions([
            { text: '切换', value: { cmd: 'ws.use', name }, style: 'primary' },
            { text: '删除', value: { cmd: 'ws.removeAsk', name }, style: 'danger' },
          ]),
        );
      }
      if (i < entries.length - 1) elements.push(HR);
    });
    elements.push(HR);
    elements.push(...inlineActions([{ text: '取消', value: { cmd: 'ws.cancel' } }]));
  }

  return shell('📂 工作空间', elements);
}

export function statusCard(info: ContextInfo): object {
  const scopeLine =
    info.chatMode === 'topic'
      ? `窗口 \`${escapeCode(info.scope)}\` _（话题独立会话）_`
      : `窗口 \`${escapeCode(info.scope)}\``;
  const wsLine =
    info.wsNames.length > 0
      ? info.wsNames.map((n) => `\`${escapeCode(n)}\``).join(' ')
      : '_（当前目录无快捷方式）_';
  const sessionPanel = [
    md('**🗂 会话**'),
    // 没有真名字就不渲染这一行：占位的「未命名」会让人以为会话有名字。
    ...(info.sessionName ? [md(`🏷 ${escapeMd(info.sessionName)}`)] : []),
    md(
      info.sessionId
        ? `🔗 \`${escapeCode(info.sessionId)}\``
        : '🔗 _无，下条消息新建_',
    ),
    md(`🕒 ${formatClockOr(info.createdAt, '—')}`),
    md(`🕘 ${formatAgoOr(info.updatedAt, '新会话')}`),
    md(info.running ? '🔄 任务执行中' : '✅ 空闲'),
  ];
  const envPanel = [
    md('**🧩 环境**'),
    md(`📁 \`${escapeCode(tildePath(info.cwd))}\``),
    md(`🤖 ${escapeMd(info.agentName)}`),
    md(`🎛 ${info.model ? `\`${escapeCode(info.model)}\`` : '_跟随默认_'}`),
    md(`💭 ${info.thinking ? `\`${escapeCode(info.thinking)}\`` : '_跟随默认_'}`),
    md(`⏱ ${escapeMd(info.idleLine)}`),
    md(`📂 ${wsLine}`),
  ];
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

  return shell('📊 会话状态', [
    md('📊 **会话状态**', 'heading'),
    md(scopeLine, 'notation'),
    ...stackedPanels([panel(sessionPanel), panel(envPanel), ...recentPanel]),
    ...(info.sessionStale
      ? [md('⚠️ _session 来自旧 cwd，下一条消息将新建会话_', 'notation')]
      : []),
  ]);
}

/** /cd success card: the new cwd, the session-reset consequence, and the
 * two most likely follow-ups (workspace list, status). */
export function cwdChangedCard(cwd: string, scopeNote?: string): object {
  return shell('📁 已切换工作目录', [
    md('📁 **已切换工作目录**', 'heading'),
    ...(scopeNote ? [md(`_${escapeMd(scopeNote)}_`, 'notation')] : []),
    md(`新的 cwd：\`${escapeCode(tildePath(cwd))}\``),
    md('_session 已重置，下一条消息在新目录开始。_', 'notation'),
    { tag: 'hr' },
    ...inlineActions([
      { text: '📂 工作空间', value: { cmd: 'ws.list' } },
      { text: '📊 会话状态', value: { cmd: 'status' } },
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
    elements.push(md('_⚠️ diff 已截断_', 'notation'));
  }
  return shell('📦 git diff', elements);
}

export interface ExecResultInfo {
  cmd: string;
  /** 执行目录（命令就在这里跑）：卡上单独一行，失败时也是排查的第一现场。 */
  cwd: string;
  exitCode: number | null;
  output: string;
  timedOut: boolean;
  /** For the timeout title, e.g. 30. */
  timeoutSeconds: number;
  /** 没有退出码时的原因（目录不存在 / spawn 失败 / 被信号终止）；缺失时才
   *  退回笼统的「未知原因」。 */
  reason?: string;
}

/** /exec result: outcome heading + the command + collapsed output panel. */
export function execResultCard(info: ExecResultInfo): object {
  const ok = !info.timedOut && info.exitCode === 0;
  // 失败时只写「无法执行」等于把排查线索丢掉：把原因（目录不存在 / spawn 失败 /
  // 被信号终止）明写进标题。`reason` 是调用方拼好的中文短语，仍按不可信文本转义。
  const failReason = escapeMd(info.reason?.trim() || '原因未知');
  const title = info.timedOut
    ? `⏱ **执行超时**（${info.timeoutSeconds}s），已终止`
    : info.exitCode === null
      ? `❌ **无法执行**：${failReason}`
      : ok
        ? '✅ **命令执行完成**'
        : `❌ **命令失败**（退出码 ${info.exitCode}）`;
  const elements: object[] = [
    md(title, 'heading'),
    md(`\`$ ${escapeCode(info.cmd)}\``, 'notation'),
    md(`📁 \`${escapeCode(shortPath(info.cwd))}\``, 'notation'),
  ];
  if (info.output.trim()) {
    elements.push(
      collapsiblePanel({
        title: '📄 **输出**',
        expanded: !ok,
        border: ok ? 'grey' : 'red',
        body: codeFence(info.output),
      }),
    );
  } else {
    elements.push(md('_（无输出）_', 'notation'));
  }
  return shell('🖥 命令执行', elements);
}

/** /ps card: one row per running bot, current one starred. 退出 is a two-step
 * confirm: the first click only swaps that row for a confirm row (no process
 * is touched), the confirm button carries the real `exit`. Admin gate enforced
 * by the dispatcher. */
export interface PsRow {
  id: string;
  appId: string;
  botName?: string;
  startedAgo: string;
  isCurrent: boolean;
}

export interface PsCardOpts {
  /** 该进程的「退出」已进入二次确认态：这一行换成确认行。 */
  confirmId?: string;
  /** 本进程即将退出：标题改成告别态，且不渲染任何退出按钮（点了也无人应答）。 */
  exitingSelf?: boolean;
}

export function psCard(rows: PsRow[], opts: PsCardOpts = {}): object {
  const { confirmId, exitingSelf } = opts;
  const blocks: object[] = [
    md(exitingSelf ? '👋 **本 bot 即将退出**' : `🖥 **Bot 进程** ×${rows.length}`, 'heading'),
  ];
  if (exitingSelf) {
    blocks.push(md('_正在关闭本进程，此卡片将不再响应点击。_', 'notation'));
  }
  if (rows.length === 0) {
    blocks.push(md('_当前没有其它 bot 在运行。_', 'notation'));
  }
  rows.forEach((row, i) => {
    const label = row.botName ?? row.appId;
    // 一个进程一个灰底块，行尾「退出」横排。
    blocks.push(
      ...stackedPanels([
        panel([
          md(`**#${i + 1}** ${escapeMd(label)}${row.isCurrent ? ' ⭐ 当前' : ''}`),
          md(`_\`${escapeCode(row.id)}\` · ${escapeMd(row.appId)} · ${escapeMd(row.startedAgo)}启动_`, 'notation'),
        ]),
      ]),
    );
    if (exitingSelf) {
      // 本进程正在关闭：退出按钮此刻已无处投递，不渲染（点了只会像坏掉）。
      return;
    }
    if (confirmId === row.id) {
      blocks.push(
        md(
          row.isCurrent
            ? '_⚠️ 这是**正在回复你的进程**，确认后会立即断开，需要人工重新拉起。_'
            : '_⚠️ 确认关闭该 bot？_',
          'notation',
        ),
        ...confirmActions(
          [{ text: '确认退出', value: { cmd: 'exit', arg: row.id }, style: 'danger' }],
          { text: '取消', value: { cmd: 'exit.cancel', arg: row.id } },
        ),
      );
    } else {
      // 首态只用 `exit.ask`：真正执行的 `exit` 只在确认行出现。
      blocks.push(
        ...inlineActions([
          { text: '退出', value: { cmd: 'exit.ask', arg: row.id }, style: 'danger' },
        ]),
      );
    }
  });
  if (!exitingSelf) {
    blocks.push(
      { tag: 'hr' },
      md('_用 /exit <id|#> 关掉某一个；⭐ 为当前正在回复你的进程。退出需二次确认。_', 'notation'),
    );
  }
  return shell(exitingSelf ? '👋 即将退出' : '🖥 Bot 进程', blocks);
}

/** /every list card: one collapsible per scheduled task with an inline
 * 删除 button. */
export interface EveryRow {
  id: string;
  interval: string;
  nextRun: string;
  prompt: string;
}

/** 标题里的 prompt 只是一行摘要：**含省略号**总长 40 字符（中文按字符计）。完整
 *  指令在面板里的代码块，所以这里宁可截断也不要糊掉截断点。 */
const PROMPT_TITLE_MAX = 40;

export function everyCard(rows: EveryRow[]): object {
  if (rows.length === 0) {
    return shell('📅 定时任务', [
      md('📅 **定时任务**', 'heading'),
      md('暂无定时任务。'),
      md('_发 `/every <间隔> <指令>` 添加，间隔如 `30m`/`2h`/`1d`。_', 'notation'),
    ]);
  }
  const elements: object[] = [md(`📅 **定时任务** ×${rows.length}`, 'heading')];
  rows.forEach((row, i) => {
    const promptTitle =
      row.prompt.length > PROMPT_TITLE_MAX
        ? `${row.prompt.slice(0, PROMPT_TITLE_MAX - 1)}…`
        : row.prompt;
    elements.push(
      collapsiblePanel({
        title: `⏱ **每 ${escapeMd(row.interval)}** · ${escapeMd(row.nextRun)} — ${escapeMd(promptTitle)}`,
        expanded: false,
        border: 'grey',
        elements: [
          md(codeFence(row.prompt)),
          button({ text: '🗑 删除', value: { cmd: 'every.rm', arg: row.id }, style: 'danger' }),
        ],
      }),
    );
    if (i < rows.length - 1) elements.push({ tag: 'hr' });
  });
  elements.push(md('_发 `/every rm <id>` 也可以删除任务。_', 'notation'));
  return shell('📅 定时任务', elements);
}

/** /compact progress card. `tokensK`/`mb`/`eta`/`cap` are preformatted by the
 * caller (they own the estimation math); omit them when no estimate exists. */
export interface CompactInfo {
  phase: 'started' | 'done' | 'failed';
  tokensK?: string;
  mb?: string;
  eta?: string;
  cap?: string;
  error?: string;
}

export function compactCard(info: CompactInfo): object {
  if (info.phase === 'started') {
    const sizeBlock =
      info.tokensK !== undefined
        ? stackedPanels([
            panel([
              md(`📏 会话 ≈**${info.tokensK}k** token · **${info.mb}** MB`),
              md(`⏳ 预计 ≈${info.eta}（上限 ${info.cap}）`),
            ]),
          ])
        : [md('_（无法估算会话大小，耐心等待…）_', 'notation')];
    return shell('🫧 压缩会话', [
      md('🫧 **正在压缩会话上下文**', 'heading'),
      md('_完成后会在这里通知你。_', 'notation'),
      ...sizeBlock,
    ]);
  }
  if (info.phase === 'failed') {
    return shell('❌ 压缩失败', [
      md('❌ **压缩失败**', 'heading'),
      ...(info.error ? [md(codeFence(info.error))] : []),
    ]);
  }
  return shell('✅ 压缩完成', [
    md('✅ **会话上下文已压缩**', 'heading'),
    md('_下条消息生效。_', 'notation'),
  ]);
}

/** /release progress card: per-step ✅/⏳/○ states with a failure tail. */
export type ReleaseStepName = 'typecheck' | 'test' | 'build';
export type ReleaseStepState = 'pending' | 'running' | 'ok' | 'failed';
const RELEASE_STEP_LABEL: Record<ReleaseStepName, string> = {
  typecheck: '类型检查',
  test: '测试',
  build: '构建',
};

export interface ReleaseProgress {
  steps: Array<{ name: ReleaseStepName; status: ReleaseStepState }>;
  /** `restarting` is the pre-boot state: build succeeded, process is being
   * bounced. The NEW process flips it to `success` once it is actually up. */
  phase: 'running' | 'restarting' | 'success' | 'failed';
  /** `force`：用户显式跳过 run 排空，卡片上写明，免得把中断当成异常。 */
  forced?: boolean;
  /**
   * 排空阶段：流水线已跑完，正在等在跑的 run 收尾 —— 当作**当前步骤**渲染，
   * 否则卡片停在「typecheck ✅、后面全空」，用户读到的就是卡死。数量由
   * `waitForRunsToDrain` 的回调刷新。
   */
  drain?: { runningCount: number; timeoutMs: number };
  /** `force`：跳过排空、重启时会被中断的在跑 run 数（0 时不写数字）。 */
  interruptedCount?: number;
  /** Failure details from the failing step. */
  failStep?: ReleaseStepName;
  failNote?: string;
  output?: string;
}

const STEP_MARK: Record<ReleaseStepState, string> = {
  pending: '⭕️',
  running: '⏳',
  ok: '✅',
  failed: '❌',
};

/**
 * 排空等待的时限文案。时限是**调用方的策略**（命令层的 `RELEASE_DRAIN_MAX_MS`）：
 * 卡片层不持有默认值，省略时就不写「最多 N 分钟」，而不是自己编一个数字。
 */
function drainEtaLabel(timeoutMs: number): string {
  const minutes = timeoutMs / 60_000;
  return `最多 ${Number.isInteger(minutes) ? minutes : minutes.toFixed(1)} 分钟`;
}

/**
 * `force` 重启的代价文案。0 个在跑时**不写**「中断 0 个」这种废话（读起来像故障），
 * 改成明说当前无在跑会话。`/release` 与 `/restart` 共用同一句话。
 */
function forceInterruptNote(runningCount: number): string {
  return runningCount > 0
    ? `_强制重启：立即中断 ${runningCount} 个在跑的会话，服务马上重启。_`
    : '_强制重启：当前无在跑会话，服务马上重启。_';
}

export function releaseCard(progress: ReleaseProgress): RunCard {
  const icon =
    progress.phase === 'failed'
      ? '❌'
      : progress.phase === 'success'
        ? '🚀'
        : progress.phase === 'restarting'
          ? '🚀'
          : '🔄';
  const title =
    progress.phase === 'failed'
      ? `**发布失败于 ${RELEASE_STEP_LABEL[progress.failStep ?? 'typecheck']}**`
      : progress.phase === 'success'
        ? '**已发布上线**'
        : progress.phase === 'restarting'
          ? '**构建完成，正在重启加载新产物**'
          : '**正在发布**';
  const steps = progress.steps.map((s) =>
    md(`${STEP_MARK[s.status]} ${RELEASE_STEP_LABEL[s.name]}`),
  );
  // 排空等待也是「当前步骤」：不加这一行，卡片就停在所有流水线步骤打勾、
  // 后面空着的样子 —— 正是用户以为发布卡死的画面。
  const drain = progress.drain;
  if (drain) {
    steps.push(
      md(
        `${STEP_MARK.running} 等待 ${drain.runningCount} 个在跑的会话收尾（${drainEtaLabel(drain.timeoutMs)}）`,
      ),
    );
  }
  const elements: object[] = [
    md(`${icon} ${title}`, 'heading'),
    { tag: 'hr' },
    // column 必须包在 column_set 里（cardkit 11310 "unsupported type of
    // block: column"）——与 statusCard 的双面板同构。空 steps 时整个面板
    // 省略：空 column 会渲染成一个空的灰框。
    ...(steps.length > 0
      ? [
          {
            tag: 'column_set',
            flex_mode: 'none',
            columns: [panel(steps)],
          } as object,
        ]
      : []),
    { tag: 'hr' },
  ];
  if (progress.phase === 'failed') {
    if (progress.failNote) elements.push(md(escapeMd(progress.failNote)));
    if (progress.output) elements.push(md(codeFence(progress.output)));
  } else if (progress.phase === 'success') {
    elements.push(md('_进程已发布并重启。_', 'notation'));
  } else if (progress.phase === 'restarting') {
    elements.push(
      md(
        progress.forced
          ? forceInterruptNote(progress.interruptedCount ?? 0)
          : '_新进程启动后会确认上线。_',
        'notation',
      ),
    );
  } else {
    elements.push(
      md(
        drain
          ? '_排空完成后自动重启加载新产物。_'
          : progress.forced
            ? '_typecheck → test → build → 强制重启（不等在跑的 run）_'
            : '_typecheck → test → build → 自动重启_',
        'notation',
      ),
    );
  }
  return shell(`${icon} 发布`, elements);
}

/** Replacement card for a recall that failed — no buttons, so a stale
 * interactive surface cannot be clicked after its flow moved on. */
export function staleNoticeCard(): object {
  return {
    schema: '2.0',
    // 没有 summary 时通知栏/会话列表预览是空灰块，看不出这张卡说了什么。
    config: { update_multi: true, summary: { content: '⚠️ 卡片已过期' } },
    body: {
      elements: [
        { tag: 'markdown', content: '_⚠️ 此卡片已过期，请使用最新发出的卡片。_' },
      ],
    },
  };
}
/** /restart status card. A real launchd restart leaves the starting card in
 * place; the new process supplies the separate boot confirmation.
 *
 * `draining` is the visible waiting state: 非 force 时要等在跑的 run 收尾
 * （最长 5 分钟），卡片只说「正在重启」会让用户以为卡死。 */
export function restartCard(
  phase: 'draining' | 'starting' | 'done' | 'failed',
  error?: string,
  options: { forced?: boolean; runningCount?: number; timeoutMs?: number } = {},
): object {
  if (phase === 'done') {
    return shell('🚀 重启完成', [
      md('🚀 **重启完成**', 'heading'),
      md('_已重新连接，可以继续发送消息。_', 'notation'),
    ]);
  }
  if (phase === 'failed') {
    return shell('❌ 重启失败', [
      md('❌ **重启失败**', 'heading'),
      md(error ? escapeMd(error) : '_bot 仍在线，请稍后重试。_', 'notation'),
    ]);
  }
  if (phase === 'draining') {
    const running = options.runningCount ?? 0;
    return shell('⏳ 等待在跑的会话收尾', [
      md(`⏳ **正在等待 ${running} 个在跑的会话收尾**`, 'heading'),
      md(
        `_${options.timeoutMs === undefined ? '' : `${drainEtaLabel(options.timeoutMs)}；`}收尾结束后立即重启服务。_`,
        'notation',
      ),
    ]);
  }
  return shell('🔄 正在重启', [
    md('🔄 **正在重启**', 'heading'),
    md(
      options.forced
        ? forceInterruptNote(options.runningCount ?? 0)
        : '_服务即将重启；重新上线后会继续接收消息。_',
      'notation',
    ),
  ]);
}

/** Response card after an agent-authored choice button click: the choice,
 * frozen, no buttons. */
export function agentSelectedCard(label: string): object {
  // 两处渲染的是同一段不可信文本（agent 自己写的选项名），转义方式必须一致。
  const safe = escapeMd(label);
  return {
    schema: '2.0',
    config: { summary: { content: `✅ 已选择 ${safe}` } },
    body: { elements: [{ tag: 'markdown', content: `✅ 已选择：**${safe}**` }] },
  };
}

/** Boot confirmation for an ORDINARY start (crash recovery, manual launch):
 * nobody asked for the bounce, so the bot announces it came back. `/release`
 * and `/restart` are covered by their own command cards. */
export function onlineCard(): RunCard {
  return shell('🚀 已上线', [
    md('🚀 **已上线**', 'heading'),
    md('_服务已重新启动，可以继续发送消息。_', 'notation'),
  ]);
}

const HELP_GROUPS: Array<{ title: string; items: Array<[string, string]> }> = [
  {
    title: '🗂 会话管理',
    items: [
      ['/new · /reset', '重置上下文，开始新对话'],
      ['/new chat [名字]', '新建群 + 新会话，自动拉你进群'],
      ['/resume <会话 id>', '按 id / id 前缀直接恢复某条会话'],
      ['/rename <标题>', '会话命名；`auto` LLM 生成，`clear` 清除'],
      ['/status · /ctx · /context', '会话状态：会话 / 环境 / 最近内容'],
      ['/search <关键词> · /s', '跨会话历史检索'],
      [
        '/history [all] · /sessions',
        '历史会话清单，「继续对话」一键恢复；不带参数的 /resume 也走这里',
      ],
      ['/session [会话 id]', '会话清单；带 id / id 前缀直接恢复某条会话'],
      ['/diff', '查看当前会话目录未提交的改动（git diff）'],
    ],
  },
  {
    title: '🎛 偏好设置',
    items: [
      ['/config', '回复方式、工具调用显示等偏好'],
      ['/timeout [N|off|default]', '当前会话探活分钟数'],
      ['/model [id|reset]', '查看 / 切换模型'],
      ['/thinking · /think [level|reset]', '思考强度（off~max）'],
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
      ['/restart [force]', '重启当前 bot；force 跳过等待在跑的 run'],
    ],
  },
  {
    title: '🩺 进程与诊断',
    items: [
      ['/ps', '列出本机 bot，标识当前回复者'],
      ['/exit <id|#>', '关闭指定 bot'],
      ['/doctor [描述]', '日志 + 描述交给 OMP 自助诊断'],
      ['/exec <命令> · /run', '在当前 cwd 执行 shell（admin）'],
      ['/every <间隔> <指令>', '定时任务：定期执行；`list` 查看，`rm <id>` 删除'],
      ['/release [force]', '自发布：typecheck→test→build→重启；force 跳过排空'],
    ],
  },
];

/** 默认展开的分组：最常用的两组。全折叠时 `/help` 只剩 5 行标题，用户看不到
 *  任何命令，等于没有速查。 */
const HELP_EXPANDED_GROUPS: readonly string[] = ['🗂 会话管理', '⏯ 运行控制'];

export interface NewSessionInfo {
  cwd: string;
  model?: string;
  thinking?: string;
  idleLine: string;
  wasRunning: boolean;
  /** Rendered under the heading, e.g. topic chats: 「话题独立会话」。 */
  scopeNote?: string;
}

/** Compact /new confirmation — deliberately NOT the full /context dump:
 * a fresh session has nothing to show for 「开始/最后对话」 yet. */
export function newSessionCard(info: NewSessionInfo): object {
  return shell('✅ 上下文已重置', [
    md(
      info.wasRunning
        ? '✅ **已中断当前任务并重置上下文**'
        : '✅ **已重置上下文**',
      'heading',
    ),
    ...(info.scopeNote ? [md(`_${escapeMd(info.scopeNote)}_`, 'notation')] : []),
    ...stackedPanels([
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
    ]),
  ]);
}

export function helpCard(): object {
  const elements: object[] = [md('💡 **命令速查**', 'heading')];
  // Each category collapses to one row — the card stays short; open a group
  // to read its commands. 会话管理 / 运行控制 默认展开：其余分组折叠，卡片仍然短。
  HELP_GROUPS.forEach((group) => {
    elements.push(
      collapsiblePanel({
        title: `**${group.title}**`,
        expanded: HELP_EXPANDED_GROUPS.includes(group.title),
        border: 'grey',
        elements: [
          md(group.items.map(([cmd, desc]) => `\`${cmd}\` — ${desc}`).join('\n')),
        ],
      }),
    );
  });
  elements.push(md('_发送 `/help` 随时查看；其他内容直接交给 OMP。_', 'notation'));
  // 新建会话排在最前：速查卡里最常用的动作（等同 `/new`）。并排行每行最多 2 个，
  // 4 个动作于是折成两行（见 inlineRow 的规则说明）。
  elements.push(
    ...inlineActions([
      { text: '🆕 新建会话', value: { cmd: 'new' }, style: 'primary' },
      { text: '🕘 恢复会话', value: { cmd: 'resume' } },
      { text: '📊 会话状态', value: { cmd: 'status' } },
      { text: '📂 工作空间', value: { cmd: 'ws.list' } },
    ]),
  );
  return shell('💡 命令速查', elements);
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
