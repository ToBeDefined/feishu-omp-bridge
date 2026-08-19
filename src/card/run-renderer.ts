import type { Block, FooterStatus, RunState, ToolEntry, UiState } from './run-state';
import { toolBodyMd, toolHeaderText } from './tool-render';

const REASONING_MAX = 1500;
const COLLAPSE_TOOL_THRESHOLD = 3;
/** Single markdown element cap for agent body text (feishu per-element limit ~30KB; keep well under). */
const TEXT_BLOCK_MAX = 8000;

interface ToolGroup {
  kind: 'tools';
  tools: ToolEntry[];
}
interface TextGroup {
  kind: 'text';
  content: string;
}
type Group = ToolGroup | TextGroup;

export function renderCard(state: RunState): object {
  const elements: object[] = [];

  if (state.reasoning.content) {
    elements.push(reasoningPanel(state.reasoning.content, state.reasoning.active));
  }

  const ui = uiContextPanel(state.ui);
  if (ui) elements.push(ui);

  const groups = [...groupBlocks(state.blocks)];
  const finalized = state.terminal !== 'running';
  const totalTools = groups.reduce(
    (n, g) => n + (g.kind === 'tools' ? g.tools.length : 0),
    0,
  );

  if (totalTools >= COLLAPSE_TOOL_THRESHOLD) {
    // Global tool collapse: render text blocks in order, then ALL tools as a
    // single collapsed summary (latest tool visible while running). The old
    // per-group collapse let the element count grow linearly with tool count
    // — long tasks (60+ tools split across many small groups) blew past
    // Feishu's element limit (ErrCode 11310) and 400'd the whole card stream,
    // freezing the card on a mid-run state.
    const allTools = groups.flatMap((g) => (g.kind === 'tools' ? g.tools : []));
    for (const group of groups) {
      if (group.kind === 'text' && group.content.trim()) {
        elements.push(markdown(truncate(group.content, TEXT_BLOCK_MAX)));
      }
    }
    const prior = finalized ? allTools : allTools.slice(0, -1);
    const latest = finalized ? undefined : allTools[allTools.length - 1];
    if (prior.length > 0) elements.push(collapsedToolSummary(prior, finalized));
    if (latest) elements.push(toolPanel(latest, true));
  } else {
    for (const group of groups) {
      if (group.kind === 'text') {
        if (group.content.trim()) {
          elements.push(markdown(truncate(group.content, TEXT_BLOCK_MAX)));
        }
      } else {
        elements.push(...renderToolGroup(group.tools, finalized));
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

function renderToolGroup(tools: ToolEntry[], finalized: boolean): object[] {
  if (tools.length === 0) return [];
  if (tools.length < COLLAPSE_TOOL_THRESHOLD) {
    return tools.map((t) => toolPanel(t, false));
  }
  if (finalized) {
    return [collapsedToolSummary(tools, true)];
  }
  // Running: collapse prior tools, keep latest visible.
  const prior = tools.slice(0, -1);
  const latest = tools[tools.length - 1];
  const out: object[] = [];
  if (prior.length > 0) out.push(collapsedToolSummary(prior, false));
  if (latest) out.push(toolPanel(latest, true));
  return out;
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

/**
 * Render N tool calls as a single collapsed panel. **Body content is dropped**
 * — only the per-tool header line (icon + name + short summary) is kept.
 *
 * Why no bodies: with full input/output panels nested, the serialized JSON
 * can easily exceed Feishu's per-element size limit (~30KB), causing 400
 * errors that abort the entire card stream. Tool details are still in the
 * file log; users who really need them can `/doctor` to inspect.
 *
 * The latest-running tool, when applicable, is rendered separately via
 * `toolPanel(latest, true)` so live observation isn't sacrificed.
 */
function collapsedToolSummary(tools: ToolEntry[], finalized: boolean): object {
  const suffix = finalized ? '（已结束）' : '';
  const title = `☕ **${tools.length} 个工具调用${suffix}**`;
  const headerList = tools.map((t) => `- ${toolHeaderText(t)}`).join('\n');
  return {
    tag: 'collapsible_panel',
    expanded: false,
    header: panelHeader(title),
    border: { color: 'blue', corner_radius: '5px' },
    vertical_spacing: '8px',
    padding: '8px 8px 8px 8px',
    elements: [{ tag: 'markdown', content: headerList, text_size: 'notation' }],
  };
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
    body: lines.join('\n\n'),
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
