import type { Block, FooterStatus, RunState, ToolEntry, UiState } from './run-state';
import { toolBodyMd, toolHeaderText } from './tool-render';

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
type Group = ToolGroup | TextGroup;

/** Per-page markers for the card pagination flow (see batch.ts streamCardPages). */
export interface CardPageOptions {
  /** Note rendered at the top of the card ("continues previous message"). */
  topNote?: string;
  /** Note rendered at the bottom ("continues in the next message"). */
  bottomNote?: string;
}

export function renderCard(state: RunState, opts?: CardPageOptions): object {
  const elements: object[] = [];

  if (opts?.topNote) elements.push(noteElement(opts.topNote));

  if (state.reasoning.content) {
    elements.push(reasoningPanel(state.reasoning.content, state.reasoning.active));
  }

  const ui = uiContextPanel(state.ui);
  if (ui) elements.push(ui);

  // Every tool gets its own expandable panel — body (input+output) visible.
  // The caller (batch.ts) paginates the card stream by size budget, so the
  // element count is bounded per page and no collapse is needed here.
  const totalTools = state.blocks.filter((b) => b.kind === 'tool').length;
  let toolIdx = 0;
  for (const group of groupBlocks(state.blocks)) {
    if (group.kind === 'text') {
      if (group.content.trim()) {
        elements.push(markdown(group.content));
      }
    } else {
      for (const tool of group.tools) {
        const isLatest = state.terminal === 'running' && toolIdx === totalTools - 1;
        elements.push(toolPanel(tool, isLatest));
        toolIdx += 1;
      }
    }
  }

  if (state.terminal === 'interrupted') {
    elements.push(noteMd('_⏹ 已被中断_'));
  } else if (state.terminal === 'idle_timeout') {
    const mins = state.idleTimeoutMinutes ?? 0;
    elements.push(noteMd(`_⏱ ${mins} 分钟无响应,已自动终止_`));
  } else if (state.terminal === 'error' && state.errorMsg) {
    elements.push(noteMd(`⚠️ agent 失败：${state.errorMsg}`));
  } else if (state.terminal === 'done' && elements.length === 0) {
    elements.push(noteMd('_（未返回内容）_'));
  }

  if (state.terminal === 'running') {
    if (state.footer) elements.push(footerStatus(state.footer));
    elements.push(stopButton());
  }

  if (opts?.bottomNote) elements.push(noteElement(opts.bottomNote));

  return {
    schema: '2.0',
    config: {
      streaming_mode: state.terminal === 'running',
      summary: { content: summaryText(state) },
    },
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
      yield { kind: 'text', content: b.content };
    }
  }
  if (toolBuf.length > 0) yield { kind: 'tools', tools: toolBuf };
}

function reasoningPanel(content: string, active: boolean): object {
  const title = active ? '🧠 **思考中**' : '🧠 **思考完成，点击查看**';
  return collapsiblePanel({
    title,
    expanded: active,
    border: 'grey',
    body: truncate(content, REASONING_MAX),
  });
}

function toolPanel(tool: ToolEntry, expanded: boolean): object {
  return collapsiblePanel({
    title: toolHeaderText(tool),
    expanded,
    border: tool.status === 'error' ? 'red' : 'grey',
    body: toolBodyMd(tool) || '_无输出_',
  });
}

interface PanelOpts {
  title: string;
  expanded: boolean;
  border: 'grey' | 'red' | 'blue';
  body: string;
}

function collapsiblePanel(opts: PanelOpts): object {
  return {
    tag: 'collapsible_panel',
    expanded: opts.expanded,
    header: panelHeader(opts.title),
    border: { color: opts.border, corner_radius: '5px' },
    vertical_spacing: '8px',
    padding: '8px 8px 8px 8px',
    elements: [{ tag: 'markdown', content: opts.body, text_size: 'notation' }],
  };
}

function panelHeader(titleMd: string): object {
  return {
    title: { tag: 'markdown', content: titleMd },
    vertical_align: 'center',
    icon: { tag: 'standard_icon', token: 'down-small-ccm_outlined', size: '16px 16px' },
    icon_position: 'follow_text',
    icon_expanded_angle: -180,
  };
}

function markdown(content: string): object {
  return { tag: 'markdown', content };
}

function noteMd(content: string): object {
  return { tag: 'markdown', content, text_size: 'notation' };
}

/** A card `note` element (small grey caption, non-interactive). */
function noteElement(text: string): object {
  return { tag: 'note', elements: [{ tag: 'plain_text', content: text }] };
}

function stopButton(): object {
  return {
    tag: 'button',
    text: { tag: 'plain_text', content: '⏹ 终止' },
    type: 'danger',
    behaviors: [{ type: 'callback', value: { cmd: 'stop' } }],
  };
}

function footerStatus(status: Exclude<FooterStatus, null>): object {
  const text =
    status === 'thinking'
      ? '🧠 正在思考'
      : status === 'tool_running'
        ? '🧰 正在调用工具'
        : status === 'waiting_input'
          ? '🧩 等待用户交互'
          : '✍️ 正在输出';
  return noteMd(text);
}

function uiContextPanel(ui: UiState): object | undefined {
  const lines: string[] = [];
  if (ui.title) lines.push(`**标题**：${ui.title}`);
  for (const [key, text] of Object.entries(ui.statuses)) {
    lines.push(`**${key}**：${text}`);
  }
  for (const [key, widget] of Object.entries(ui.widgets)) {
    const placement = widget.placement ? `_${widget.placement}_` : '';
    lines.push(`**${key}** ${placement}\n${(widget.lines ?? []).join('\n')}`.trim());
  }
  if (ui.editorText) lines.push(`**编辑器内容**\n\`\`\`\n${truncate(ui.editorText, 1200)}\n\`\`\``);
  if (lines.length === 0) return undefined;
  return collapsiblePanel({
    title: '🧩 **OMP 状态 / Widget**',
    expanded: true,
    border: 'blue',
    body: truncate(lines.join('\n\n'), UI_PANEL_MAX),
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
