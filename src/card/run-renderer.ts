import type { Block, FooterStatus, RunState, SubagentEntry, ToolEntry, UiState } from './run-state';
import { toolBodyMd, toolHeaderText } from './tool-render';
import { createTableBudget, type TableBudget } from './tables';
import { codeFence, collapsiblePanel, escapeMd } from './templates';

/** Max chars per reasoning body — reasoning is auxiliary, truncation is fine. */
const REASONING_MAX = 1500;
/** Cap for the OMP UI panel body (widget/status text). */
const UI_PANEL_MAX = 2500;

interface ToolGroup {
  kind: 'tools';
  tools: ToolEntry[];
}
interface TextGroup {
  kind: 'text';
  content: string;
}
interface ThinkingGroup {
  kind: 'thinking';
  content: string;
  active: boolean;
}
type Group = ToolGroup | TextGroup | ThinkingGroup;

/** Per-page markers for the card pagination flow (see batch.ts streamCardPages). */
export interface CardPageOptions {
  /** Note rendered at the top of the card ("continues previous message"). */
  topNote?: string;
  /** Note rendered at the bottom ("continues in the next message"). */
  bottomNote?: string;
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

  // Consecutive tool calls share ONE collapsible「🛠 工具调用」group row —
  // the run's body stays mostly answer text; open the group to see each call
  // (each call keeps its own header + merged body, as before).
  const bodyElements: object[] = [];
  for (const group of groupBlocks(state.blocks)) {
    if (group.kind === 'text') {
      if (group.content.trim()) {
        bodyElements.push(markdown(tables(group.content)));
      }
    } else if (group.kind === 'thinking') {
      // Thinking segments render collapsed at their chronological position.
      if (hasReasoningSubstance(group.content)) {
        bodyElements.push(
          reasoningPanel(group.content, group.active, tables),
        );
      }
    } else {
      bodyElements.push(toolGroupPanel(group.tools));
    }
  }

  if (opts?.topNote) elements.push(noteMd(opts.topNote));

  const ui = uiContextPanel(state.ui, tables);
  if (ui) elements.push(ui);

  for (const line of subagentLines(state.subagents)) elements.push(noteMd(line));
  for (const element of bodyElements) elements.push(element);

  if (state.terminal === 'interrupted') {
    elements.push(noteMd('_⏹ 已被中断_'));
  } else if (state.terminal === 'idle_timeout') {
    const mins = state.idleTimeoutMinutes ?? 0;
    elements.push(noteMd(`_⏱ ${mins} 分钟无响应,已自动终止_`));
  } else if (state.terminal === 'error' && state.errorMsg) {
    elements.push(noteMd(`⚠️ agent 失败：${escapeMd(state.errorMsg)}`));
  } else if (state.terminal === 'done' && elements.length === 0) {
    elements.push(noteMd('_（未返回内容）_'));
  }

  if (state.terminal === 'running') {
    if (state.footer) {
      elements.push(runningFooter(state.footer));
    } else {
      elements.push(stopButton());
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

function* groupBlocks(blocks: Block[]): Generator<Group> {
  let toolBuf: ToolEntry[] = [];
  for (const b of blocks) {
    if (b.kind === 'tool') {
      toolBuf.push(b.tool);
    } else {
      if (toolBuf.length > 0) {
        yield { kind: 'tools', tools: toolBuf };
        toolBuf = [];
      }
      if (b.kind === 'thinking') {
        yield { kind: 'thinking', content: b.content, active: b.active };
      } else {
        yield { kind: 'text', content: b.content };
      }
    }
  }
  if (toolBuf.length > 0) yield { kind: 'tools', tools: toolBuf };
}

/** Some models emit a bare "." as an empty thinking slot — reasoning panels
 * need actual words/digits to be worth a collapsible panel. */
function hasReasoningSubstance(content: string): boolean {
  return /[\p{L}\p{N}]/u.test(content);
}

function subagentLines(entries: SubagentEntry[]): string[] {
  return entries.map((s) => {
    const label = escapeMd(s.agent);
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

/** Status note on the left + ⏹ stop button on the right, one aligned row. */
function runningFooter(status: Exclude<FooterStatus, null>): object {
  const text =
    status === 'thinking'
      ? '🧠 正在思考'
      : status === 'tool_running'
        ? '🛠 正在调用工具'
        : status === 'waiting_input'
          ? '🧩 等待用户交互'
          : '✍️ 正在输出';
  return {
    tag: 'column_set',
    flex_mode: 'none',
    horizontal_spacing: 'small',
    columns: [
      {
        tag: 'column',
        width: 'weighted',
        weight: 1,
        vertical_align: 'center',
        elements: [noteMd(text)],
      },
      {
        tag: 'column',
        width: 'auto',
        vertical_align: 'center',
        elements: [stopButton()],
      },
    ],
  };
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
