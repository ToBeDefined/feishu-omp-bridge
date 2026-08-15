import { homedir } from 'node:os';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { paths } from '../../config/paths';
import { forgetManagedCard, sendManagedCard, updateManagedCard } from '../../card/managed';
import type { CommandContext, Handler } from '../index';
import { FORM_SETTLE_MS, recallMessage, reply } from '../shared';
import { extractUserInput, scanSessionFile } from './context';
import { applyResume } from './resume';
import { summarize } from './shared';

export const searchHandlers: Record<string, Handler> = {
  '/search': handleSearch,
};

interface SearchHit {
  role: 'user' | 'assistant';
  content: string;
  timestamp?: string;
}

interface SearchContext {
  messages: SearchHit[];
  hitIndex: number;
  sessionId?: string;
  workspace?: string;
}

/** In-memory cache of recent search results, keyed by a short query id. */
const searchCache = new Map<string, SearchContext[]>();
const SEARCH_CACHE_MAX = 20;

/** Extract the real conversational text for a message frame. */
function messageText(msg: {
  role?: string;
  content?: Array<{ type?: string; text?: string }>;
}): SearchHit | null {
  if (!msg?.role) return null;
  const textPart = (msg.content ?? [])
    .filter((c) => c.type === 'text' && c.text)
    .map((c) => c.text ?? '')
    .join('');
  if (!textPart) return null;
  if (msg.role === 'assistant') {
    return { role: 'assistant', content: textPart.trim() };
  }
  if (msg.role === 'user') {
    const real = extractUserInput(textPart);
    return real ? { role: 'user', content: real } : null;
  }
  return null;
}

/** Search every session file (across workspaces), returning one context per
 * unique matched Q&A pair (the hit plus its user/assistant counterpart).
 * Newest first, capped at `limit`. */
export async function searchSession(
  keyword: string,
  ctx: CommandContext,
  limit = 6,
): Promise<SearchContext[]> {
  const needle = keyword.toLowerCase();
  const contexts: SearchContext[] = [];
  try {
    const entries = await readdir(paths.ompSessionsDir);
    for (const name of entries) {
      if (!name.endsWith('.jsonl')) continue;
      let text: string;
      try {
        text = await readFile(join(paths.ompSessionsDir, name), 'utf8');
      } catch {
        continue;
      }
      // Cheap prefilter: skip files that can't contain the keyword at all.
      if (!text.toLowerCase().includes(needle)) continue;

      const { meta } = scanSessionFile(text);
      const sessionId = meta?.id;
      const workspace = workspaceLabel(ctx, meta?.cwd || homedir());

      const stream: SearchHit[] = [];
      for (const line of text.split('\n')) {
        if (!line.includes('"type":"message"')) continue;
        try {
          const frame = JSON.parse(line) as {
            timestamp?: string;
            message?: { role?: string; content?: Array<{ type?: string; text?: string }> };
          };
          const hit = messageText(frame.message as { role?: string; content?: Array<{ type?: string; text?: string }> });
          if (hit) {
            hit.timestamp = frame.timestamp;
            stream.push(hit);
          }
        } catch {
          /* skip malformed */
        }
      }

      // One context per unique matched Q&A pair. Both halves of a pair can
      // match the keyword (question and answer), so dedupe by pair identity
      // to avoid emitting the same exchange twice.
      const seenPairs = new Set<string>();
      for (let i = 0; i < stream.length; i++) {
        if (!stream[i]!.content.toLowerCase().includes(needle)) continue;
        let pair: SearchHit[];
        let hitIndex: number;
        if (
          stream[i]!.role === 'user' &&
          i + 1 < stream.length &&
          stream[i + 1]!.role === 'assistant'
        ) {
          pair = [stream[i]!, stream[i + 1]!];
          hitIndex = 0;
        } else if (
          stream[i]!.role === 'assistant' &&
          i - 1 >= 0 &&
          stream[i - 1]!.role === 'user'
        ) {
          pair = [stream[i - 1]!, stream[i]!];
          hitIndex = 1;
        } else {
          pair = [stream[i]!];
          hitIndex = 0;
        }
        const key = pair.map((m) => m.timestamp ?? m.content).join('|');
        if (seenPairs.has(key)) continue;
        seenPairs.add(key);
        contexts.push({
          messages: pair.map((m) => ({ ...m, timestamp: m.timestamp })),
          hitIndex,
          sessionId,
          workspace,
        });
      }
    }
  } catch {
    /* fall through */
  }
  contexts.sort((a, b) =>
    (b.messages[b.hitIndex]?.timestamp ?? '').localeCompare(a.messages[a.hitIndex]?.timestamp ?? ''),
  );
  return contexts.slice(0, limit);
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

function workspaceLabel(ctx: CommandContext, cwd: string): string {
  for (const [name, path] of Object.entries(ctx.workspaces.listNamed())) {
    if (path === cwd) return name;
  }
  return cwd;
}

async function handleSearch(args: string, ctx: CommandContext): Promise<void> {
  const [sub, ...rest] = args.trim().split(/\s+/);

  if (sub === 'resume') {
    const sess = ctx.sessions.getRaw(ctx.scope);
    if (!sess?.sessionId) {
      await reply(ctx, '当前没有可继续的会话。');
      return;
    }
    await applyResume(ctx, {
      sessionId: sess.sessionId,
      cwd: sess.cwd ?? homedir(),
      timestamp: '',
    });
    return;
  }

  if (sub === 'done') {
    const queryRef = rest.join(' ').trim();
    const [queryId, idxStr] = queryRef.split(/\s+/);
    const contexts = searchCache.get(queryId ?? '');
    if (ctx.fromCardAction) {
      const msgId = ctx.msg.messageId;
      void (async () => {
        await new Promise((r) => setTimeout(r, FORM_SETTLE_MS));
        try {
          if (idxStr) {
            const idx = Number.parseInt(idxStr, 10);
            const context = contexts?.[idx - 1];
            const sessionId = context?.sessionId;
            const wsLabel = context?.workspace ?? '';
            const full = context ? renderSearchContext(context, 'detail') : '';
            await updateManagedCard(
              ctx.channel,
              msgId,
              searchDetailCard(sessionId, full, undefined, idx, true, wsLabel),
            );
          } else {
            // Results list card: strip buttons, keep the list with the
            // workspace / session context intact.
            await updateManagedCard(
              ctx.channel,
              msgId,
              searchResultsCard('', contexts ?? [], queryId ?? '', false),
            );
          }
        } catch {
          /* ignore */
        }
        forgetManagedCard(msgId);
      })();
    }
    return;
  }

  if (sub === 'show') {
    const queryId = rest[0] ?? '';
    const idx = Number.parseInt(rest[1] ?? '', 10);
    const contexts = searchCache.get(queryId);
    if (!contexts) {
      await reply(ctx, '搜索结果已过期，请重新 `/search`。');
      return;
    }
    const context = contexts[idx - 1];
    if (!context) {
      await reply(ctx, `无效的序号 \`${idx}\`。`);
      return;
    }
    const full = renderSearchContext(context, 'detail');
    const sessionId = context.sessionId;
    const wsLabel = context.workspace ?? '';
    if (ctx.fromCardAction) {
      await sendManagedCard(
        ctx.channel,
        ctx.msg.chatId,
        searchDetailCard(sessionId, full, `${queryId} ${idx}`, idx, false, wsLabel),
      ).catch(() => {});
    } else {
      await reply(ctx, `${sessionId ? `🆔 session: \`${sessionId}\`\n\n` : ''}${full}`);
    }
    return;
  }

  const keyword = args.trim();
  if (!keyword) {
    await reply(ctx, '用法：`/search <关键词>` — 在所有会话历史中检索（跨工作区）。');
    return;
  }
  const contexts = await searchSession(keyword, ctx);
  if (contexts.length === 0) {
    await reply(ctx, `未找到包含 \`${keyword}\` 的消息。`);
    return;
  }
  const queryId = `s${Date.now().toString(36)}`;
  searchCache.set(queryId, contexts);
  if (searchCache.size > SEARCH_CACHE_MAX) {
    const oldest = searchCache.keys().next().value;
    if (oldest) searchCache.delete(oldest);
  }
  if (ctx.fromCardAction) await recallMessage(ctx, ctx.msg.messageId);
  await sendManagedCard(
    ctx.channel,
    ctx.msg.chatId,
    searchResultsCard(keyword, contexts, queryId, true),
  );
}

function searchResultsCard(
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
  const blocks: object[] = [];
  contexts.forEach((c, i) => {
    const metaLine = [
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
                  value: { cmd: 'search.resume' },
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

function searchDetailCard(
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
                value: { cmd: 'search.resume' },
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
