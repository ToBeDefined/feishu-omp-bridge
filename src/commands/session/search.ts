import { homedir } from 'node:os';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { paths } from '../../config/paths';
import { forgetManagedCard, sendManagedCard, updateManagedCard } from '../../card/managed';
import type { CommandContext, Handler } from '../index';
import { FORM_SETTLE_MS, codeSpan, recallMessage, reply } from '../shared';
import { extractUserInput, scanSessionFile } from './context';
import { applyResume, listResumableSessions } from './resume';
import { renderSearchContext, searchDetailCard, searchResultsCard, workspaceLabel } from '../../card/search-card';
import type { SearchContext, SearchHit } from '../../card/search-card';

export const searchHandlers: Record<string, Handler> = {
  '/search': handleSearch,
  '/s': handleSearch,
};

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
 * matched session: hits within one session collapse into a single entry
 * (newest hit pair as the representative snippet, total in `matchCount`).
 * Newest first, capped at `limit` sessions. */
export async function searchSession(
  keyword: string,
  ctx: CommandContext,
  limit = 6,
): Promise<SearchContext[]> {
  const needle = keyword.toLowerCase();
  const contexts: Array<SearchContext & { groupKey: string }> = [];
  const sessionTitles = ctx.sessions?.titlesBySessionId?.() ?? {};
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
      const title = sessionId ? sessionTitles[sessionId] : undefined;

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
          ...(title !== undefined ? { title } : {}),
          // Group key: one session id per file pair; fall back to the file
          // name when a session file has no id, so the same session never
          // shows up more than once.
          groupKey: sessionId ?? name,
        });
      }
    }
  } catch {
    /* fall through */
  }
  contexts.sort((a, b) =>
    (b.messages[b.hitIndex]?.timestamp ?? '').localeCompare(a.messages[a.hitIndex]?.timestamp ?? ''),
  );
  // Collapse same-session hits into one entry, newest pair first; the first
  // (newest) pair stays as the representative snippet.
  const grouped = new Map<string, SearchContext>();
  for (const c of contexts) {
    const existing = grouped.get(c.groupKey);
    if (existing) {
      existing.matchCount = (existing.matchCount ?? 1) + 1;
      continue;
    }
    const { groupKey: _ignored, ...rest } = c;
    grouped.set(c.groupKey, { ...rest, matchCount: 1 });
  }
  return [...grouped.values()].slice(0, limit);
}

async function handleSearch(args: string, ctx: CommandContext): Promise<void> {
  const [sub, ...rest] = args.trim().split(/\s+/);

  if (sub === 'resume') {
    // 卡片按钮带目标 sessionId（命中会话）。没有 arg 时保持旧语义：
    // 提示当前会话状态（直接发 `/s resume` 的场景）。
    const targetId = rest.join('').trim();
    if (targetId) {
      const sessions = await listResumableSessions(ctx);
      const match = sessions.find((s) => s.sessionId === targetId);
      if (!match) {
        await reply(ctx, `❌ 该会话已不存在或无法恢复：\`${targetId}\``);
        return;
      }
      await applyResume(ctx, match);
      return;
    }
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
    await reply(ctx, `未找到包含 \`${codeSpan(keyword)}\` 的消息。`);
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
