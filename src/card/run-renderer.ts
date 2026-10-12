import type {
  Block,
  FooterStatus,
  RunState,
  RunUsage,
  SubagentEntry,
  ToolEntry,
  UiState,
} from './run-state';
import { toolBodyMd, toolHeaderText } from './tool-render';
import { createTableBudget, type TableBudget } from './tables';
import { codeFence, collapsiblePanel, md } from './templates';
import { codeSpan, escapeMd } from '../utils/text';

/** Max chars per reasoning body — reasoning is auxiliary, truncation is fine. */
const REASONING_MAX = 1500;
/** Cap for the OMP UI panel body (widget/status text). */
const UI_PANEL_MAX = 2500;

/** One process element inside a contiguous tool/thinking stretch. */
type ProcessItem =
  | { kind: 'tools'; tools: ToolEntry[] }
  | { kind: 'thinking'; content: string; active: boolean };

/** A render op: answer text, or a contiguous process stretch (no text
 *  between its elements) that collapses into one outer row. */
type RenderOp = { kind: 'text'; content: string } | { kind: 'process'; items: ProcessItem[] };

/** Per-page markers for the card pagination flow (see batch.ts streamCardPages). */
export interface CardPageOptions {
  /** 早先关掉的续页（后面还有一张卡）：不显示底部控制区（耗时/token/状态）。 */
  midPage?: boolean;
  /** Note rendered at the top of the card ("continues previous message"). */
  topNote?: string;
  /** Note rendered at the bottom ("continues in the next message"). */
  bottomNote?: string;
  /**
   * Render clock (epoch ms) for the elapsed-time text. Injected so the
   * heartbeat's ticking clock is testable, and so the byte-budget probe and
   * the card actually pushed read the SAME instant (the 「用时」 string changes
   * length at the 60s boundary, so measuring and sending must not disagree).
   * Falls back to `Date.now()` when the caller has no clock to hand.
   */
  now?: number;
}

/** The CardKit 2.0 envelope `renderCard` produces. Named so callers can
 *  read `body.elements.length` (pagination budget) without casts. */
export interface RunCard {
  schema: string;
  /** No `streaming_mode` — see the comment in `renderCard`. */
  config: { summary: { content: string } };
  body: { elements: object[] };
}

export function renderCard(state: RunState, opts?: CardPageOptions): RunCard {
  const elements: object[] = [];
  // Tables are budgeted per card, and the reply's own tables are charged
  // first: auxiliary panels (reasoning, OMP UI) only spend what is left, so a
  // chatty thinking block can never push the answer's tables into code blocks.
  const tables = createTableBudget();
  const now = opts?.now ?? Date.now();

  // 不再加顶层标题：运行卡以前没有、也不需要有（用户明确说 `🤖 OMP` 是噪音）。
  // 卡片第一行直接就是状态结果行（仅终态）或正文，信息密度优先。

  // Answer text renders inline; a contiguous stretch of process elements
  // (tool runs + thinking segments with no text in between) collapses into
  // ONE outer row —「🧠 思考 ×N · 🛠 工具 ×M」when both kinds are
  // present, or the plain tool/thinking row when only one kind is.
  const bodyElements: object[] = [];
  for (const op of collectOps(state.blocks)) {
    bodyElements.push(
      op.kind === 'text'
        ? markdown(tables(op.content))
        : renderProcessRun(op.items, tables),
    );
  }

  // Terminal headline (what happened) still goes first, ahead of the body: a
  // long answer used to bury the failure mark below the fold.
  const head = resultRow(state);
  if (head) elements.push(head);

  if (opts?.topNote) elements.push(noteMd(opts.topNote));

  // OMP 状态面板与子代理行属于「本轮的运行态」：续页（midPage）只带内容 +
  // 分页提示，否则每一页都重复顶一块面板，白吃该页预算（用户也要求续页干净）。
  if (!opts?.midPage) {
    const ui = uiContextPanel(state.ui, tables);
    if (ui) elements.push(ui);
    for (const line of subagentLines(state.subagents)) elements.push(noteMd(line));
  }
  for (const element of bodyElements) elements.push(element);

  // Failure detail stays in the body: the headline above says WHAT happened,
  // this says why (OMP's own message, often long).
  if (state.terminal === 'error' && state.errorMsg) {
    elements.push(noteMd(`⚠️ agent 失败：${escapeMd(state.errorMsg)}`));
  } else if (state.terminal === 'done' && elements.length === 0) {
    elements.push(noteMd('_（未返回内容）_'));
  }

  // 底部控制区（仅运行态）：一条分割线，下面是
  // `token/费用` 与 `状态 · 用时` 两行堆在左列，⏹ 终止 在右列与这两行垂直居中。
  // 早先关掉的续页（`midPage`，后面还有一张卡）不渲染这块：耗时/token/状态只在
  // **最新**那一页给出，旧页上的快照数字不该被当成终值。
  if (opts?.midPage) {
    // 续页只剩内容 + 「已分页，下一条消息继续」的 bottomNote。
  } else if (state.terminal === 'running') {
    const usageText = usageLine(state);
    const left: object[] = [];
    if (usageText) left.push(noteMd(usageText));
    left.push(noteMd(statusLine(state, now)));
    // 没有任何正文时不要以 hr 开头（纯装饰分隔线）。
    if (elements.length > 0) elements.push({ tag: 'hr' });
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
          elements: left,
        },
        {
          tag: 'column',
          width: 'auto',
          vertical_align: 'center',
          elements: [stopButton()],
        },
      ],
    });
  } else {
    const usage = usageNote(state, now);
    if (usage) {
      elements.push({ tag: 'hr' });
      elements.push(usage);
    }
  }

  if (opts?.bottomNote) elements.push(noteMd(opts.bottomNote));

  return {
    schema: '2.0',
    // Deliberately NOT `streaming_mode: true`: that flag puts the client into
    // CardKit streaming mode, whose content channel is
    // `cardkit.cardElement.content` (typewriter pushes). A card in that mode
    // ignores full-card `im.message.patch` replacements until the mode ends,
    // so the user only ever sees the final state. This stream updates by
    // patching the whole card, so it must stay out of streaming mode.
    config: { summary: { content: summaryText(state) } },
    body: { elements },
  };
}

/**
 * Fold the chronological blocks into render ops: text stays text; a
 * contiguous stretch of tools and/or thinking collapses into ONE process op
 * (consecutive tool blocks are one run; thinking segments join the same op).
 * Blank text and substance-less thinking (a bare ".") drop out here, so the
 * op's counts match what is actually rendered.
 */
function collectOps(blocks: Block[]): RenderOp[] {
  const ops: RenderOp[] = [];
  let toolBuf: ToolEntry[] = [];
  const pushProcess = (item: ProcessItem): void => {
    const last = ops[ops.length - 1];
    if (last?.kind === 'process') last.items.push(item);
    else ops.push({ kind: 'process', items: [item] });
  };
  const flushTools = (): void => {
    if (toolBuf.length === 0) return;
    pushProcess({ kind: 'tools', tools: toolBuf });
    toolBuf = [];
  };
  for (const b of blocks) {
    if (b.kind === 'tool') {
      toolBuf.push(b.tool);
      continue;
    }
    flushTools();
    if (b.kind === 'thinking') {
      if (hasReasoningSubstance(b.content)) {
        pushProcess({ kind: 'thinking', content: b.content, active: b.active });
      }
      continue;
    }
    if (b.content.trim()) ops.push({ kind: 'text', content: b.content });
  }
  flushTools();
  return ops;
}

/**
 * Render one process stretch as a single outer row.
 *
 * Single kind → the plain row (「🛠 工具调用 ×N」/「🧠 思考过程」), unchanged.
 * Both kinds → one merged row titled「🧠 思考 ×N · 🛠 工具 ×M」whose
 * children are the individual calls and thinking segments IN CHRONOLOGICAL
 * ORDER (so tool,thinking,tool reads top-to-bottom inside one group instead
 * of stacking three separate rows).
 */
function renderProcessRun(items: ProcessItem[], tables: TableBudget): object {
  const tools = items.flatMap((it) => (it.kind === 'tools' ? it.tools : []));
  const thoughts = items.filter((it) => it.kind === 'thinking');
  // 只有工具 / 只有思考都**不能**走下面的合并行：缺的那一侧会渲染成「×0」
  // （只有思考时曾出现「🧠 思考 ×2 · 🛠 工具 ×0」）。只有思考时也不带计数
  // —— 用户明确要求「只有思考时不存在 ×N」。
  if (tools.length === 0) {
    const only = thoughts[0];
    return thoughts.length === 1 && only
      ? reasoningPanel(only.content, only.active, tables)
      : thinkingGroupPanel(thoughts, tables);
  }
  if (thoughts.length === 0) return toolGroupPanel(tools);

  const toolCount = items.reduce((n, it) => (it.kind === 'tools' ? n + it.tools.length : n), 0);
  const thinkingCount = items.reduce((n, it) => (it.kind === 'thinking' ? n + 1 : n), 0);
  const failed = items.reduce(
    (n, it) => (it.kind === 'tools' ? n + it.tools.filter((t) => t.status === 'error').length : n),
    0,
  );
  const suffix = failed > 0 ? `（${failed} 失败）` : '';
  // Thinking first, tools last: the stretch usually opens with reasoning, and
  // trailing the tool count lets its failure count sit at the end of the
  // title instead of dangling next to an unrelated count. The noun is
  // 合并行用短词「工具」（用户要求）；只有工具的单类行仍写全「工具调用」。
  return collapsiblePanel({
    title: `🧠 **思考** ×${thinkingCount} · 🛠 **工具** ×${toolCount}${suffix}`,
    expanded: false,
    border: failed > 0 ? 'red' : 'grey',
    elements: items.flatMap((it) =>
      it.kind === 'tools'
        ? it.tools.map((t) => toolPanel(t))
        : [reasoningPanel(it.content, it.active, tables)],
    ),
  });
}

/** Some models emit a bare "." as an empty thinking slot — reasoning panels
 * need actual words/digits to be worth a collapsible panel. */
function hasReasoningSubstance(content: string): boolean {
  return /[\p{L}\p{N}]/u.test(content);
}

function subagentLines(entries: SubagentEntry[]): string[] {
  return entries.map((s) => {
    // code span 内必须用 codeSpan：反斜杠转义在 `...` 里不生效，
    // `a_b` 这种名字会原样渲染成 `a\_b`。
    const label = codeSpan(s.agent);
    const desc = s.description ? ` — ${escapeMd(truncate(s.description, 80))}` : '';
    switch (s.status) {
      case 'started':
        return `🤖 子代理 \`${label}\`${desc} _工作中_`;
      case 'completed':
        return `✅ 子代理 \`${label}\`${desc} _完成_`;
      case 'failed':
        return `❌ 子代理 \`${label}\`${desc} _失败_`;
      case 'aborted':
        return `⏹ 子代理 \`${label}\`${desc} _已中止_`;
    }
  });
}

/** Outer「🧠 思考过程」group: several consecutive thinking segments collapsed
 *  into one row. **不带 ×N** —— 只有思考时用户要求不出现计数（`active` 时段落
 *  仍在生成，标题沿用「思考中…」）。 */
function thinkingGroupPanel(
  thoughts: Array<{ content: string; active: boolean }>,
  tables: TableBudget,
): object {
  // 多段思考合并进**一个**正文块：早先套 N 个同名 reasoningPanel，展开后是一摞
  // 名字一样的折叠面板，分不清哪段是哪段。
  return collapsiblePanel({
    title: thoughts.some((t) => t.active) ? '🧠 **思考中…**' : '🧠 **思考过程**',
    expanded: false,
    border: 'grey',
    body: tables(truncate(thoughts.map((t) => t.content).join('\n\n---\n\n'), REASONING_MAX)),
  });
}

function reasoningPanel(content: string, active: boolean, tables: TableBudget): object {
  const title = active ? '🧠 **思考中…**' : '🧠 **思考过程**';
  return collapsiblePanel({
    title,
    expanded: false,
    border: 'grey',
    body: tables(truncate(content, REASONING_MAX)),
  });
}

/** Outer「🛠 工具调用」group: one collapsed row for a burst of consecutive
 * tool calls. Red border when any call failed; the count shows in the title. */
function toolGroupPanel(tools: ToolEntry[]): object {
  const failed = tools.filter((t) => t.status === 'error').length;
  const suffix = failed > 0 ? `（${failed} 失败）` : '';
  return collapsiblePanel({
    title: `🛠 **工具调用** ×${tools.length}${suffix}`,
    expanded: false,
    border: failed > 0 ? 'red' : 'grey',
    elements: tools.map((t) => toolPanel(t)),
  });
}

/** One tool call inside the group: header = status + summary, body = the
 * merged input + output markdown (single layer, as before). */
function toolPanel(tool: ToolEntry): object {
  return collapsiblePanel({
    title: toolHeaderText(tool),
    expanded: false,
    border: tool.status === 'error' ? 'red' : 'grey',
    body: toolBodyMd(tool) || '_无输出_',
  });
}

function markdown(content: string): object {
  return { tag: 'markdown', content };
}

function noteMd(content: string): object {
  return { tag: 'markdown', content, text_size: 'notation' };
}

function stopButton(): object {
  return {
    tag: 'button',
    text: { tag: 'plain_text', content: '⏹ 终止' },
    type: 'danger',
    behaviors: [{ type: 'callback', value: { cmd: 'stop' } }],
  };
}

/** 终态结果行（卡片第一个元素）：失败 / 探活超时 / 被中断用一个 heading 说明，
 *  而不是文末一行小灰字。运行态没有这一行 —— 状态与 ⏹ 都在卡片底部的控制区里
 *  （见 `renderCard` 的运行态拼装）。成功的 `done` 不加横幅：答案本身不需要盖章，
 *  且分页中间页也是以 `done` 渲染的，加「已完成」就是撒谎。 */
function resultRow(state: RunState): object | undefined {
  if (state.terminal === 'interrupted') return md('⏹ **已被中断**', 'heading');
  if (state.terminal === 'idle_timeout') {
    const mins = state.idleTimeoutMinutes ?? 0;
    return md(`⏱ **${mins} 分钟无响应，已自动终止**`, 'heading');
  }
  if (state.terminal === 'error') return md('❌ **运行失败**', 'heading');
  return undefined;
}

/** 运行态状态行：agent 在干什么 + 已用时长（示例：`🧠 正在思考 · ⏱ 1 分 32 秒`）。 */
function statusLine(state: RunState, now: number): string {
  return (
    [footerLabel(state.footer), elapsedText(state, now)].filter(Boolean).join(' · ') || '🔄 运行中'
  );
}

/** 用量行（只有 token）：已用时长归下面的状态行；花费不再显示（用户要求）。 */
function usageLine(state: RunState): string | undefined {
  const usage = state.usage;
  if (!usage) return undefined;
  return tokensText(usage);
}

function footerLabel(status: FooterStatus): string | undefined {
  switch (status) {
    case 'thinking':
      return '🧠 正在思考';
    case 'tool_running':
      return '🛠 正在调用工具';
    case 'waiting_input':
      return '⌛ 等待用户交互';
    case 'streaming':
      return '✍️ 正在输出';
    default:
      return undefined;
  }
}

/** `⏱ 12.4s`（或 `⏱ 1 分 31 秒`）—— run 的墙钟。状态没带起跑时刻时返回 undefined
 *  （`/doctor` 这类合成 run 复用 `initialState`），脚注就不写时长，而不是假的 0s。 */
function elapsedText(state: RunState, now: number): string | undefined {
  if (state.startedAt === undefined) return undefined;
  return `⏱ ${formatDuration(Math.max(0, (state.endedAt ?? now) - state.startedAt))}`;
}

/** 12.4s under a minute; 1 分 5 秒 past it. Exported so callers that build
 *  their own footer line (e.g. `/doctor`) share the exact format. */
export function formatDuration(ms: number): string {
  const secs = ms / 1000;
  if (secs < 60) return `${secs.toFixed(1)}s`;
  const mins = Math.floor(secs / 60);
  const rest = Math.round(secs - mins * 60);
  return rest === 60 ? `${mins + 1} 分` : `${mins} 分 ${rest} 秒`;
}

/** Bottom notation line: 用时 / token 数, whichever we actually have —
 *  no usage event means no token text, and nothing at all means no line (never
 *  an empty placeholder). 花费不显示（用户要求：过程中与结束都不要）。 */
function usageNote(state: RunState, now: number): object | undefined {
  const parts: string[] = [];
  if (state.terminal !== 'running') {
    const elapsed = elapsedText(state, now);
    if (elapsed) parts.push(elapsed);
  }
  const usage = state.usage;
  if (usage) {
    const tokens = tokensText(usage);
    if (tokens) parts.push(tokens);
  }
  return parts.length > 0 ? noteMd(parts.join(' · ')) : undefined;
}

/** `🧮 12.3k token（in 11.1k / out 1.2k）` —— 只写服务端真给了的那侧。 */
function tokensText(usage: RunUsage): string | undefined {
  const input = usage.inputTokens;
  const output = usage.outputTokens;
  if (input === undefined && output === undefined) return undefined;
  const sides: string[] = [];
  if (input !== undefined) sides.push(`in ${formatTokens(input)}`);
  if (output !== undefined) sides.push(`out ${formatTokens(output)}`);
  return `🧮 ${formatTokens((input ?? 0) + (output ?? 0))} token（${sides.join(' / ')}）`;
}

/** 940 → `940`, 12345 → `12.3k`, 1234567 → `1.2M`. Shared with /doctor's footer. */
export function formatTokens(n: number): string {
  if (n < 1000) return String(n);
  if (n < 1_000_000) return `${trimZero(n / 1000)}k`;
  return `${trimZero(n / 1_000_000)}M`;
}

function trimZero(v: number): string {
  const s = v.toFixed(1);
  return s.endsWith('.0') ? s.slice(0, -2) : s;
}

function uiContextPanel(ui: UiState, tables: TableBudget): object | undefined {
  const lines: string[] = [];
  if (ui.title) lines.push(`**标题**：${escapeMd(ui.title)}`);
  for (const [key, text] of Object.entries(ui.statuses)) {
    lines.push(`**${escapeMd(key)}**：${escapeMd(text)}`);
  }
  for (const [key, widget] of Object.entries(ui.widgets)) {
    const placement = widget.placement ? `_${escapeMd(widget.placement)}_` : '';
    const widgetLines = (widget.lines ?? []).map(escapeMd).join('\n');
    lines.push(`**${escapeMd(key)}** ${placement}\n${widgetLines}`.trim());
  }
  if (ui.editorText) {
    lines.push(`**编辑器内容**：\n${codeFence(truncate(ui.editorText, 1200))}`);
  }
  if (lines.length === 0) return undefined;
  return collapsiblePanel({
    // 折叠 + 灰底：与全仓其它组面板一致（曾是全仓唯一 expanded:true / blue 的面板，
    // 2500 字的展开块会把答案顶到折叠线以下）。
    title: '📡 **OMP 状态**',
    expanded: false,
    border: 'grey',
    body: tables(truncate(lines.join('\n\n'), UI_PANEL_MAX)),
  });
}

function summaryText(state: RunState): string {
  if (state.terminal === 'interrupted') return '已中断';
  if (state.terminal === 'idle_timeout') return '已超时';
  if (state.terminal === 'error') return '运行失败';
  if (state.terminal === 'done') return '已完成';
  if (state.footer === 'tool_running') return '正在调用工具';
  if (state.footer === 'streaming') return '正在输出';
  if (state.footer === 'waiting_input') return '等待用户交互';
  return '思考中';
}

function truncate(s: string, max: number): string {
  return s.length > max ? `${s.slice(0, max)}…` : s;
}
