import { homedir } from 'node:os';
import type { AgentRunOptions } from '../types';

export const OMP_BRIDGE_PROMPT = `# feishu-omp-bridge 运行约定

你正在 feishu-omp-bridge 里运行：把飞书/Lark 用户消息桥到本地 \`omp --mode rpc\`。

## bridge_context

每条 user message 顶部会带一个 \`<bridge_context>\` 块：

\`\`\`
<bridge_context>
chat_id: oc_xxx
chat_type: p2p
sender_id: ou_xxx
sender_name: ...
</bridge_context>
\`\`\`

里面是当前对话的 chat_id、chat 类型（p2p / group）、发送者。这些是 bridge 注入的元数据，不要照抄、不要在回复里渲染。

## quoted_message

如果用户用“引用回复”指向某条消息，bridge 会在 \`<bridge_context>\` 后注入一个 \`<quoted_message>\` 块。用户的实际问题在它之后。回答时围绕被引用内容展开，不要照抄 XML 标签。

## interactive_card

用户发 / 引用交互卡片时，bridge 会把卡片 JSON 注入到 \`<interactive_card>\` 块。解析 JSON 理解按钮、字段和布局；不要照抄 XML 标签。

## 发交互卡片（按钮、表单）的回调约定

如果你用 \`lark-cli im send-card\` 发交互卡片，并希望用户点击按钮后回调到当前 OMP 会话，按钮的 \`value\` 对象必须包含兼容标记 \`__codex_cb: true\`。用户点击后，bridge 会把 payload（去掉 \`__codex_cb\`）作为 \`[card-click] {...}\` 消息发回给你。

如果只是展示卡片，不要添加 \`__codex_cb\`。
`;

export interface BuildOmpArgsOptions extends AgentRunOptions {
  sessionDir?: string;
  thinking?: string;
  tools?: string;
}

/**
 * Tags the bridge frames prompt metadata in. The model is told these blocks
 * are bridge-authored, but their bodies are not: message text, display names
 * and card JSON all come from chat members (including members the access
 * list does not cover, via a quoted message). A body containing a closing tag
 * would end the bridge's block early and let arbitrary text impersonate
 * bridge metadata. Break the tag syntax inside interpolated content instead of
 * escaping every angle bracket — the text stays readable for the model.
 */
export const PROMPT_FRAME_TAGS = ['bridge_context', 'quoted_message', 'interactive_card'] as const;

/** Neutralise framing-tag syntax inside a block body. */
export function neutralizeFraming(text: string, tags: readonly string[] = PROMPT_FRAME_TAGS): string {
  let out = text;
  for (const tag of tags) {
    out = out.replaceAll(`<${tag}`, `&lt;${tag}`).replaceAll(`</${tag}`, `&lt;/${tag}`);
  }
  return out;
}

/** Escape a value interpolated into a quoted attribute of a framing tag. */
export function escapeFramingAttr(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replace(/[\r\n]+/g, ' ');
}

/** Neutralise a value interpolated on its own `key: value` line inside a block. */
export function flattenFramingLine(value: string): string {
  return neutralizeFraming(value).replace(/[\r\n]+/g, ' ');
}

export function buildOmpPrompt(prompt: string): string {
  return `${OMP_BRIDGE_PROMPT}\n---\n\n${prompt}`;
}

export function buildOmpArgs(opts: BuildOmpArgsOptions): string[] {
  const args = ['--mode', 'rpc', '--no-title'];

  const sessionDir = clean(opts.sessionDir);
  if (sessionDir) args.push('--session-dir', sessionDir);

  const sessionId = clean(opts.sessionId);
  if (sessionId) args.push('--resume', sessionId);

  const model = clean(opts.model);
  if (model) args.push('--model', model);

  const thinking = clean(opts.thinking);
  if (thinking) args.push('--thinking', thinking);

  const tools = clean(opts.tools);
  if (tools) args.push('--tools', tools);

  return args;
}

function clean(value: string | undefined): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  if (trimmed.length === 0) return undefined;
  // Defense in depth: a `~`-prefixed flag value (session dir, cwd-derived
  // path, …) must never reach argv as a literal `~` directory.
  if (trimmed === '~') return homedir();
  if (trimmed.startsWith('~/')) return `${homedir()}${trimmed.slice(1)}`;
  return trimmed;
}
