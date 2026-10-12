import type { Block, RunState, ToolEntry, UiState } from './run-state';
import { toolHeaderText } from './tool-render';
import { codeFence } from './templates';
import { escapeMd } from '../utils/text';

/** Max chars of a failed tool's error body carried into the text fallback. */
const TOOL_ERROR_MAX = 600;

/**
 * Render `RunState` as plain markdown text — used in `messageReply: 'text'`
 * mode where we stream a markdown message instead of a card.
 *
 * Differences vs `renderCard`:
 *   - No collapsible panels, no buttons (markdown messages have neither)
 *   - Tool calls collapse to a single short line each (no body) — except
 *     failed calls, whose error body IS the reason the run looks broken
 *   - Footer is appended inline at the bottom while running
 *   - Thinking is folded away (no panel to collapse it into, so it would bury
 *     the answer)
 */
export function renderText(state: RunState): string {
  const parts: string[] = [];

  const ui = renderUiContext(state.ui);
  if (ui) parts.push(ui);
  for (const block of state.blocks) {
    const piece = renderBlock(block);
    if (piece) parts.push(piece);
  }

  if (state.terminal === 'interrupted') {
    parts.push('_⏹ 已被中断_');
  } else if (state.terminal === 'idle_timeout') {
    const mins = state.idleTimeoutMinutes ?? 0;
    parts.push(`_⏱ ${mins} 分钟无响应，已自动终止_`);
  } else if (state.terminal === 'error') {
    // 失败原因必须落到文本里：卡片路径有「❌ 运行失败」标题，文本路径曾经在
    // errorMsg 缺失时**什么都不说**，用户看到一段正文却不知道这次跑挂了。
    parts.push(state.errorMsg ? `⚠️ agent 失败：${escapeMd(state.errorMsg)}` : '⚠️ agent 失败');
  } else if (state.terminal === 'running' && state.footer) {
    parts.push(footerLine(state.footer));
  }

  return parts.join('\n\n');
}

function renderBlock(block: Block): string {
  if (block.kind === 'thinking') {
    // Text mode intentionally omits thinking — no place to fold it and it
    // would bury the answer (matches the renderer's collapsed-by-default
    // stance, just stricter).
    return '';
  }
  if (block.kind === 'text') {
    return block.content.trim();
  }
  return toolLine(block.tool);
}

/**
 * One-line summary for a tool call:
 *   `> ⏳ **Bash** — git status`
 *   `> ✅ **Read** — ~/code/foo.ts`
 * Reuses `toolHeaderText` so the format matches the card mode header.
 *
 * A failed call also carries its error body (fenced, verbatim): the card path
 * shows it inside the call's panel, and without it the text fallback reduced
 * "why did this fail" to a ❌ icon.
 */
function toolLine(tool: ToolEntry): string {
  const header = `> ${toolHeaderText(tool)}`;
  const body = tool.status === 'error' ? tool.output?.trim() : undefined;
  if (!body) return header;
  return `${header}\n${codeFence(truncate(body, TOOL_ERROR_MAX), 'text')}`;
}

function footerLine(status: 'thinking' | 'tool_running' | 'streaming' | 'waiting_input'): string {
  if (status === 'thinking') return '_🧠 正在思考_';
  if (status === 'tool_running') return '_🛠 正在调用工具…_';
  if (status === 'waiting_input') return '_⌛ 等待用户交互_';
  return '_✍️ 正在输出_';
}

function renderUiContext(ui: UiState): string {
  const lines: string[] = [];
  if (ui.title) lines.push(`- 标题：${escapeMd(ui.title)}`);
  for (const [key, text] of Object.entries(ui.statuses)) lines.push(`- ${escapeMd(key)}：${escapeMd(text)}`);
  for (const [key, widget] of Object.entries(ui.widgets)) {
    lines.push(`- ${escapeMd(key)}：${(widget.lines ?? []).map(escapeMd).join(' / ')}`);
  }
  if (ui.editorText) lines.push(`- 编辑器内容：${escapeMd(ui.editorText.slice(0, 300))}`);
  return lines.length > 0 ? `> 📡 OMP 状态\n${lines.join('\n')}` : '';
}

function truncate(s: string, max: number): string {
  return s.length > max ? `${s.slice(0, max)}…` : s;
}

/**
 * Split `text` into chunks of at most `maxBytes` UTF-8 bytes, cutting on line
 * boundaries. `chunks.join('')` reproduces `text` exactly — nothing is dropped.
 *
 * Text/markdown reply mode has no card paginator behind it: one oversized
 * message is rejected (or silently truncated) by Feishu, so the tail of a long
 * answer never reached the user. The caller passes its own budget (`maxBytes`)
 * — message-size policy belongs to the command layer, not here.
 *
 * A single line longer than the whole budget (a pathological tool output) is
 * hard-cut at a codepoint boundary; JS string slicing never splits a UTF-16
 * surrogate pair in half.
 */
export function splitText(text: string, maxBytes: number): string[] {
  if (maxBytes <= 0) throw new Error('splitText: maxBytes must be positive');
  const chunks: string[] = [];
  let current: string[] = [];
  let bytes = 0;
  const flush = (): void => {
    // 空块没有意义（空文本 / 硬切后正好落在行尾）：别让调用方发一条空消息。
    const chunk = current.join('');
    if (chunk.length > 0) chunks.push(chunk);
    current = [];
    bytes = 0;
  };

  // The newline stays attached to the line that follows it, so re-joining the
  // chunks loses no character.
  text.split('\n').forEach((line, i) => {
    const piece = i === 0 ? line : `\n${line}`;
    if (Buffer.byteLength(piece, 'utf8') > maxBytes) {
      flush();
      let rest = piece;
      while (Buffer.byteLength(rest, 'utf8') > maxBytes) {
        const [head, tail] = hardCut(rest, maxBytes);
        chunks.push(head);
        rest = tail;
      }
      if (rest.length > 0) {
        current.push(rest);
        bytes = Buffer.byteLength(rest, 'utf8');
      }
      return;
    }
    if (bytes + Buffer.byteLength(piece, 'utf8') > maxBytes) flush();
    current.push(piece);
    bytes += Buffer.byteLength(piece, 'utf8');
  });
  flush();
  return chunks;
}

/** Longest prefix of `s` whose UTF-8 size is ≤ `maxBytes` (binary search:
 *  a prefix's byte length is monotonic in its char count). */
function hardCut(s: string, maxBytes: number): [head: string, tail: string] {
  let lo = 1;
  let hi = s.length;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (Buffer.byteLength(s.slice(0, mid), 'utf8') <= maxBytes) lo = mid;
    else hi = mid - 1;
  }
  return [s.slice(0, lo), s.slice(lo)];
}
