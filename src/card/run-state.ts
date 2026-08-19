import type { AgentEvent, AgentUiWidget } from '../agent/types';

/**
 * Max characters per streaming text block. Long agent bodies split into
 * multiple blocks so each rendered markdown element stays well under
 * Feishu's per-element limit (~30KB) — the card paginator then handles the
 * total card size. Never truncate silently: content must not be dropped.
 */
export const TEXT_BLOCK_SPLIT = 4000;

export type ToolStatus = 'running' | 'done' | 'error';

export interface ToolEntry {
  id: string;
  name: string;
  input: unknown;
  status: ToolStatus;
  output?: string;
}

export type Block =
  | { kind: 'text'; content: string; streaming: boolean }
  | { kind: 'tool'; tool: ToolEntry };

export interface UiState {
  title?: string;
  statuses: Record<string, string>;
  widgets: Record<string, AgentUiWidget>;
  editorText?: string;
}

export type FooterStatus = 'thinking' | 'tool_running' | 'streaming' | 'waiting_input' | null;
export type Terminal = 'running' | 'done' | 'interrupted' | 'error' | 'idle_timeout';

export interface RunState {
  blocks: Block[];
  reasoning: { content: string; active: boolean };
  footer: FooterStatus;
  terminal: Terminal;
  ui: UiState;
  errorMsg?: string;
  /** Set when terminal === 'idle_timeout' — how long OMP was idle before
   * the watchdog gave up (so the message can say "N 分钟无响应"). */
  idleTimeoutMinutes?: number;
}

export const initialState: RunState = {
  blocks: [],
  reasoning: { content: '', active: false },
  footer: 'thinking',
  terminal: 'running',
  ui: { statuses: {}, widgets: {} },
};

function closeStreamingText(blocks: Block[]): Block[] {
  return blocks.map((b) =>
    b.kind === 'text' && b.streaming ? { ...b, streaming: false } : b,
  );
}

export function reduce(state: RunState, evt: AgentEvent): RunState {
  switch (evt.type) {
    case 'text': {
      const last = state.blocks[state.blocks.length - 1];
      if (last && last.kind === 'text' && last.streaming) {
        const merged = last.content + evt.delta;
        if (merged.length <= TEXT_BLOCK_SPLIT) {
          return {
            ...state,
            blocks: [...state.blocks.slice(0, -1), { ...last, content: merged }],
            reasoning: { ...state.reasoning, active: false },
            footer: 'streaming',
          };
        }
        // Block full: close it and start a fresh block with this delta. The
        // accumulated content stays in the closed block — nothing dropped.
        return {
          ...state,
          blocks: [
            ...state.blocks.slice(0, -1),
            { ...last, streaming: false },
            { kind: 'text', content: evt.delta, streaming: true },
          ],
          reasoning: { ...state.reasoning, active: false },
          footer: 'streaming',
        };
      }
      return {
        ...state,
        blocks: [...state.blocks, { kind: 'text', content: evt.delta, streaming: true }],
        reasoning: { ...state.reasoning, active: false },
        footer: 'streaming',
      };
    }

    case 'thinking': {
      return {
        ...state,
        reasoning: { content: state.reasoning.content + evt.delta, active: true },
        footer: 'thinking',
      };
    }

    case 'tool_use': {
      const tool: ToolEntry = {
        id: evt.id,
        name: evt.name,
        input: evt.input,
        status: 'running',
      };
      return {
        ...state,
        blocks: [...closeStreamingText(state.blocks), { kind: 'tool', tool }],
        reasoning: { ...state.reasoning, active: false },
        footer: 'tool_running',
      };
    }

    case 'tool_result': {
      const blocks = state.blocks.map((b) => {
        if (b.kind !== 'tool' || b.tool.id !== evt.id) return b;
        return {
          ...b,
          tool: {
            ...b.tool,
            status: evt.isError ? ('error' as const) : ('done' as const),
            output: evt.output,
          },
        };
      });
      return { ...state, blocks };
    }

    case 'tool_update': {
      const blocks = state.blocks.map((b) => {
        if (b.kind !== 'tool' || b.tool.id !== evt.id) return b;
        const output = b.tool.output ? `${b.tool.output}\n${evt.output}` : evt.output;
        return { ...b, tool: { ...b.tool, output } };
      });
      return { ...state, blocks };
    }


    case 'ui_request': {
      return {
        ...state,
        blocks: [
          ...closeStreamingText(state.blocks),
          {
            kind: 'text',
            content: `🧩 OMP 需要用户交互：**${evt.request.title}**\n\n已发送交互卡片，请在那里完成操作。`,
            streaming: false,
          },
        ],
        footer: 'waiting_input',
      };
    }

    case 'ui_cancel':
      return {
        ...state,
        blocks: [
          ...closeStreamingText(state.blocks),
          { kind: 'text', content: `🧩 OMP 交互已取消：${evt.targetId}`, streaming: false },
        ],
        footer: state.footer === 'waiting_input' ? null : state.footer,
      };

    case 'ui_notice':
      return {
        ...state,
        blocks: [...closeStreamingText(state.blocks), { kind: 'text', content: noticeText(evt), streaming: false }],
      };

    case 'ui_status':
      return { ...state, ui: { ...state.ui, statuses: updateStatus(state.ui.statuses, evt.status.key, evt.status.text) } };

    case 'ui_widget':
      return { ...state, ui: { ...state.ui, widgets: updateWidget(state.ui.widgets, evt.widget) } };

    case 'ui_title':
      return { ...state, ui: { ...state.ui, title: evt.title } };

    case 'ui_editor_text':
      return { ...state, ui: { ...state.ui, editorText: evt.text } };

    case 'ui_open_url':
      return {
        ...state,
        blocks: [
          ...closeStreamingText(state.blocks),
          {
            kind: 'text',
            content: `🔗 OMP 请求打开链接：${evt.url}${evt.instructions ? `\n\n${evt.instructions}` : ''}`,
            streaming: false,
          },
        ],
      };
    case 'error': {
      return { ...state, terminal: 'error', errorMsg: evt.message, footer: null };
    }

    case 'done': {
      return {
        ...state,
        blocks: closeStreamingText(state.blocks),
        reasoning: { ...state.reasoning, active: false },
        terminal: 'done',
        footer: null,
      };
    }

    default:
      return state;
  }
}

function noticeText(evt: Extract<AgentEvent, { type: 'ui_notice' }>): string {
  const icon = evt.level === 'error' ? '⚠️' : evt.level === 'warning' ? '⚠️' : 'ℹ️';
  return `${icon} ${evt.message}`;
}

function updateStatus(statuses: Record<string, string>, key: string, text: string | undefined): Record<string, string> {
  const next = { ...statuses };
  if (text === undefined || text === '') delete next[key];
  else next[key] = text;
  return next;
}

function updateWidget(widgets: Record<string, AgentUiWidget>, widget: AgentUiWidget): Record<string, AgentUiWidget> {
  const next = { ...widgets };
  if (!widget.lines || widget.lines.length === 0) delete next[widget.key];
  else next[widget.key] = widget;
  return next;
}

export function markInterrupted(state: RunState): RunState {
  return {
    ...state,
    blocks: closeStreamingText(state.blocks),
    reasoning: { ...state.reasoning, active: false },
    terminal: 'interrupted',
    footer: null,
  };
}

export function markIdleTimeout(state: RunState, minutes: number): RunState {
  return {
    ...state,
    blocks: closeStreamingText(state.blocks),
    reasoning: { ...state.reasoning, active: false },
    terminal: 'idle_timeout',
    footer: null,
    idleTimeoutMinutes: minutes,
  };
}

export function finalizeIfRunning(state: RunState): RunState {
  if (state.terminal !== 'running') return state;
  return {
    ...state,
    blocks: closeStreamingText(state.blocks),
    reasoning: { ...state.reasoning, active: false },
    terminal: 'done',
    footer: null,
  };
}
