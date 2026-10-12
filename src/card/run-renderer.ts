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
  // ONE outer row —「🧠 思考 ×N · 🛠 工具调用 ×M」when both kinds are
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

  const ui = uiContextPanel(state.ui, tables);
  if (ui) elements.push(ui);

  for (const line of subagentLines(state.subagents)) elements.push(noteMd(line));
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
    elements.push({ tag: 'hr' });
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
 * Both kinds → one merged row titled「🧠 思考 ×N · 🛠 工具调用 ×M」whose
 * children are the individual calls and thinking segments IN CHRONOLOGICAL
 * ORDER (so tool,thinking,tool reads top-to-bottom inside one group instead
 * of stacking three separate rows).
 */
function renderProcessRun(items: ProcessItem[], tables: TableBudget): object {
  const only = items.length === 1 ? items[0] : undefined;
  if (only?.kind === 'tools') return toolGroupPanel(only.tools);
  if (only?.kind === 'thinking') return reasoningPanel(only.content, only.active, tables);

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
  // 「工具调用」 — the same word the tools-only row uses.
  return collapsiblePanel({
    title: `🧠 **思考** ×${thinkingCount} · 🛠 **工具调用** ×${toolCount}${suffix}`,
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

/** 运行态状态行：agent 在干什么 + 已用时长（示例：`🧠 正在思考 · ⏱ 用时 1 分 32 秒`）。 */
function statusLine(state: RunState, now: number): string {
  return (
    [footerLabel(state.footer), elapsedText(state, now)].filter(Boolean).join(' · ') || '⏱ 运行中'
  );
}

/** 用量行（只有 token 与费用）：已用时长归下面的状态行，别重复。 */
function usageLine(state: RunState): string | undefined {
  const usage = state.usage;
  if (!usage) return undefined;
  const parts: string[] = [];
  const tokens = tokensText(usage);
  if (tokens) parts.push(tokens);
  if (usage.costUsd !== undefined) parts.push(`💰 ${formatCost(usage.costUsd)}`);
  return parts.length > 0 ? parts.join(' · ') : undefined;
}

function footerLabel(status: FooterStatus): string | undefined {
  switch (status) {
    case 'thinking':
      return '🧠 正在思考';
    case 'tool_running':
      return '🛠 正在调用工具';
    case 'waiting_input':
      return '🧩 等待用户交互';
    case 'streaming':
      return '✍️ 正在输出';
    default:
      return undefined;
  }
}

/** `⏱ 用时 12.4s` — the run's wall clock. Undefined when the state carries no
 *  start stamp (synthetic runs such as `/doctor` reuse `initialState`), in
 *  which case the footnote simply shows no duration rather than a fake 0s. */
function elapsedText(state: RunState, now: number): string | undefined {
  if (state.startedAt === undefined) return undefined;
  return `⏱ 用时 ${formatDuration(Math.max(0, (state.endedAt ?? now) - state.startedAt))}`;
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

/** Bottom notation line: 用时 / token 数 / 费用, whichever we actually have —
 *  no usage event means no token or cost text, and nothing at all means no
 *  line (never an empty placeholder). While running the elapsed clock already
 *  ticks in the header row, so a live card only adds tokens/cost here. */
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
    if (usage.costUsd !== undefined) parts.push(`💰 ${formatCost(usage.costUsd)}`);
  }
  return parts.length > 0 ? noteMd(parts.join(' · ')) : undefined;
}

/** `🧮 12.3k tok（入 11.1k / 出 1.2k）` — only the sides the provider sent. */
function tokensText(usage: RunUsage): string | undefined {
  const input = usage.inputTokens;
  const output = usage.outputTokens;
  if (input === undefined && output === undefined) return undefined;
  const sides: string[] = [];
  if (input !== undefined) sides.push(`入 ${formatTokens(input)}`);
  if (output !== undefined) sides.push(`出 ${formatTokens(output)}`);
  return `🧮 ${formatTokens((input ?? 0) + (output ?? 0))} tok（${sides.join(' / ')}）`;
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

/** 0.01234 → `$0.0123`; sub-cent amounts do not round to a free-looking $0.0000.
 *  Shared with /doctor's footer. */
export function formatCost(usd: number): string {
  if (usd === 0) return '$0';
  if (usd < 0.0001) return '<$0.0001';
  return `$${usd.toFixed(4)}`;
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
    lines.push(`**编辑器内容**\n${codeFence(truncate(ui.editorText, 1200))}`);
  }
  if (lines.length === 0) return undefined;
  return collapsiblePanel({
    title: '🧩 **OMP 状态 / Widget**',
    expanded: true,
    border: 'blue',
    body: tables(truncate(lines.join('\n\n'), UI_PANEL_MAX)),
  });
}

function summaryText(state: RunState): string {
  if (state.terminal === 'interrupted') return '已中断';
  if (state.terminal === 'idle_timeout') return '已超时';
  if (state.terminal === 'error') return '出错';
  if (state.terminal === 'done') return '已完成';
  if (state.footer === 'tool_running') return '正在调用工具';
  if (state.footer === 'streaming') return '正在输出';
  if (state.footer === 'waiting_input') return '等待用户交互';
  return '思考中';
}

function truncate(s: string, max: number): string {
  return s.length > max ? `${s.slice(0, max)}…` : s;
}
