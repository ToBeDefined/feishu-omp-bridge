import { summarize } from '../commands/shared';
import type { CommandContext } from '../commands';

/**
 * Search result card rendering (moved out of commands/session/search.ts so
 * the card layer owns all Feishu card output, matching model-card /
 * config-card / account-cards).
 */

export interface SearchHit {
  role: 'user' | 'assistant';
  content: string;
  timestamp?: string;
}

export interface SearchContext {
  messages: SearchHit[];
  hitIndex: number;
  sessionId?: string;
  workspace?: string;
  /** User-assigned session title (/rename), when the hit belongs to one. */
  title?: string;
}

export function renderSearchContext(
  context: SearchContext,
  mode: 'compact' | 'detail' = 'compact',
): string {
  return context.messages
    .map((m, i) => {
      const role = m.role === 'user' ? '🧑 **你**' : '🤖 **助手**';
      const marker = i === context.hitIndex ? '📍' : '';
      // Cap each message; compact keeps the list tight, detail shows more.
      // Assistant answers get more room than the (usually shorter) question.
      const max =
        mode === 'detail' ? (m.role === 'user' ? 600 : 1000) : m.role === 'user' ? 80 : 120;
      // Escape markdown header markers (# at line start) so message content
      // that happens to start with "# Foo" isn't rendered as a huge heading.
      const escaped = escapeSearchContent(summarize(m.content, max));
      // Markdown: role label on its own line, message content as a block
      // quote so longer snippets wrap nicely and stay visually grouped.
      return `${marker}${role}\n> ${escaped}`;
    })
    .join('\n\n');
}

/** Escape line-leading `#` (and stray `>` that could nest quotes) in
 * untrusted message content before embedding into card markdown. */
function escapeSearchContent(text: string): string {
  return text
    .split('\n')
    .map((line) => (line.startsWith('#') || line.startsWith('>') ? `\\${line}` : line))
    .join('\n');
}

export function workspaceLabel(ctx: CommandContext, cwd: string): string {
  for (const [name, path] of Object.entries(ctx.workspaces.listNamed())) {
    if (path === cwd) return name;
  }
  return cwd;
}

export function searchResultsCard(
  keyword: string,
  contexts: SearchContext[],
  queryId: string,
  showButtons = true,
): object {
  const done = !showButtons;
  const header = done
    ? `✅ 搜索完成 · ${contexts.length} 个片段`
    : `🔍 搜索 \`${keyword}\`：找到 ${contexts.length} 个片段`;
  const more = !done && contexts.length >= 6 ? '\n\n_（仅显示最近 6 个片段）_' : '';
  // Active list caps at 6 rendered items (header already notes this); the
  // done (settled) view renders everything for review.
  const shown = done ? contexts : contexts.slice(0, 6);
  const blocks: object[] = [];
  shown.forEach((c, i) => {
    const metaLine = [
      c.title ? `🏷 ${c.title}` : '',
      c.workspace ? `📁 ${c.workspace}` : '',
      c.sessionId ? `🆔 ${c.sessionId}` : '',
    ]
      .filter(Boolean)
      .join(' · ');
    const title = `#${i + 1}${metaLine ? ` · ${metaLine}` : ''}`;
    blocks.push(
      // Heading-size title so the item number / workspace / session stands
      // out; the conversation snippet below it stays at normal size.
      { tag: 'markdown', content: title, text_size: 'heading' },
      { tag: 'markdown', content: renderSearchContext(c) },
    );
    if (showButtons) {
      blocks.push(
        {
          tag: 'column_set',
          flex_mode: 'flow',
          horizontal_spacing: 'small',
          columns: [
            {
              tag: 'column',
              width: 'auto',
              elements: [
                {
                  tag: 'button',
                  text: { tag: 'plain_text', content: '查看详情' },
                  type: 'default',
                  value: { cmd: 'search.show', arg: `${queryId} ${i + 1}` },
                },
              ],
            },
            {
              tag: 'column',
              width: 'auto',
              elements: [
                {
                  tag: 'button',
                  text: { tag: 'plain_text', content: '继续对话' },
                  type: 'primary',
                  value: { cmd: 'search.resume', arg: c.sessionId },
                },
              ],
            },
          ],
        },
      );
    }
    if (i < contexts.length - 1) blocks.push({ tag: 'hr' });
  });
  if (showButtons) {
    blocks.push(
      { tag: 'hr' },
      {
        tag: 'button',
        text: { tag: 'plain_text', content: '完成' },
        type: 'default',
        value: { cmd: 'search.done', arg: queryId },
      },
    );
  }
  return {
    schema: '2.0',
    config: { summary: { content: '搜索结果' } },
    body: {
      elements: [
        { tag: 'markdown', content: header + more },
        { tag: 'hr' },
        ...blocks,
      ],
    },
  };
}

export function searchDetailCard(
  sessionId: string | undefined,
  content: string,
  queryRef?: string,
  idx?: number,
  done = false,
  workspace?: string,
): object {
  const label = idx !== undefined ? `搜索结果 #${idx}` : '搜索详情';
  const parts = [
    label,
    workspace ? `📁 ${workspace}` : '',
    sessionId ? `🆔 ${sessionId}` : '',
  ].filter(Boolean);
  // Done state keeps the full header (number / workspace / session) — only
  // the buttons are stripped. "✅" marks it as settled.
  const head = parts.length > 0 ? `✅ ${parts.join(' · ')}` : '✅ 搜索详情';
  const elements: object[] = [
    { tag: 'markdown', content: head },
    { tag: 'hr' },
    { tag: 'markdown', content },
  ];
  if (!done) {
    elements.push(
      { tag: 'hr' },
      {
        tag: 'column_set',
        flex_mode: 'flow',
        horizontal_spacing: 'small',
        columns: [
          {
            tag: 'column',
            width: 'auto',
            elements: [
              {
                tag: 'button',
                text: { tag: 'plain_text', content: '继续对话' },
                type: 'primary',
                value: { cmd: 'search.resume', arg: sessionId ?? '' },
              },
            ],
          },
          {
            tag: 'column',
            width: 'auto',
            elements: [
              {
                tag: 'button',
                text: { tag: 'plain_text', content: '完成' },
                type: 'default',
                value: { cmd: 'search.done', arg: queryRef ?? '' },
              },
            ],
          },
        ],
      },
    );
  }
  return {
    schema: '2.0',
    config: { summary: { content: '搜索详情' } },
    body: { elements },
  };
}
