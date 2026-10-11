import { homedir } from 'node:os';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { getOmpSessionDir } from '../../config/schema';
import { forgetManagedCard, sendManagedCard, updateManagedCard } from '../../card/managed';
import type { CommandContext, Handler } from '../index';
import { FORM_SETTLE_MS, recallMessage, reply } from '../shared';
import { codeSpan } from '../../utils/text';
import { extractUserInput, scanSessionFile } from './context';
import { applyResume, listResumableSessions } from './resume';
import {
  renderSearchContext,
  searchDetailCard,
  searchEmptyCard,
  searchResultsCard,
  type SearchContext,
  type SearchHit,
  type SearchHitGroup,
} from '../../card/search-card';

/** Named-workspace label for a cwd, falling back to the path itself. */
export function workspaceLabel(ctx: CommandContext, cwd: string): string {
  for (const [name, path] of Object.entries(ctx.workspaces.listNamed())) {
    if (path === cwd) return name;
  }
  return cwd;
}

export const searchHandlers: Record<string, Handler> = {
  '/search': handleSearch,
  '/s': handleSearch,
};

/** In-memory cache of recent search results, keyed by a short query id. */
const searchCache = new Map<string, SearchContext[]>();
/** Keyword per cached query id, for re-rendering pages of the same search. */
const searchKeywords = new Map<string, string>();
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

/** Resolved display + identity of the OMP session a hit belongs to. */
interface SessionIdentity {
  /** OMP session id; a headerless file falls back to its own file name. */
  sessionId: string;
  title?: string;
  topic?: string;
}

/** One session file's matched pairs, before its identity is resolved. */
interface RawHit {
  /** File header's OMP session id, when it had one. */
  sessionId?: string;
  /** JSONL file name — the identity fallback for a headerless file. */
  fileName: string;
  workspace: string;
  /** Newest matching pair in the file — the representative snippet. */
  messages: SearchHit[];
  hitIndex: number;
  /** Matched Q&A pairs in this file. */
  matchCount: number;
}

/** One session file's matched pairs, annotated with its resolved identity. */
interface SessionHit extends SessionIdentity {
  workspace: string;
  /** Newest matching pair in the file — the representative snippet. */
  messages: SearchHit[];
  hitIndex: number;
  /** Matched Q&A pairs in this file. */
  matchCount: number;
}

/**
 * Resolve a session's identity + display name, memoised by session id so a hit
 * is resolved once.
 *
 * Unlike the /status-style helper, this never calls `loadSessionSummary`: both
 * the name (title, zero IO) and the unnamed topic fallback come from the
 * search's OWN scan — `lastUserBySession` supplies the session's last user
 * message. That avoids one full-directory scan per unnamed session. A headerless
 * file is its own conversation (identity = its file name), never named.
 */
async function resolveSessionIdentity(
  ctx: CommandContext,
  sessionId: string | undefined,
  fileName: string,
  cache: Map<string, SessionIdentity>,
  lastUserBySession: ReadonlyMap<string, string>,
): Promise<SessionIdentity> {
  // 一个 OMP 会话 = 一个对话：身份就是会话 id，名字按会话 id 查（/rename）。
  const id = sessionId ?? fileName;
  const cached = cache.get(id);
  if (cached) return cached;
  const title = ctx.sessions.titleFor(id);
  let topic: string | undefined;
  if (title === undefined) {
    topic = lastUserBySession.get(id)?.trim() || undefined;
  }
  const resolved: SessionIdentity = {
    sessionId: id,
    ...(title !== undefined ? { title } : {}),
    ...(topic !== undefined ? { topic } : {}),
  };
  cache.set(id, resolved);
  return resolved;
}

/** Newest message timestamp of a hit, for the newest-first sort. */
function newestHitMs(hit: { messages: SearchHit[] }): number {
  let max = Number.NEGATIVE_INFINITY;
  for (const m of hit.messages) {
    const t = m.timestamp ? Date.parse(m.timestamp) : Number.NaN;
    if (Number.isFinite(t) && t > max) max = t;
  }
  return max;
}

/** Search every session file (across workspaces), returning one context per
 * OMP session (= one conversation): every matched pair in that session collapses
 * under a single heading (the newest pair is the representative snippet,
 * `matchCount` the total across the session). Newest first, capped at `limit`
 * sessions. */
export async function searchSession(
  keyword: string,
  ctx: CommandContext,
  limit = 6,
): Promise<SearchContext[]> {
  const needle = keyword.toLowerCase();
  const identityCache = new Map<string, SessionIdentity>();
  // `lastUserBySession` is built from search's OWN reads, so no per-session
  // `loadSessionSummary` directory scan is needed: each session's last user
  // message is the unnamed row's identity fallback.
  const lastUserBySession = new Map<string, string>();
  let names: string[] = [];
  try {
    names = (await readdir(getOmpSessionDir(ctx.controls.cfg))).filter((n) => n.endsWith('.jsonl'));
  } catch {
    return [];
  }
  const rawHits: RawHit[] = [];
  // Bound parallelism: session dirs can have hundreds of jsonl files;
  // unbounded Promise.all would spike RSS on a big history.
  const SCAN_CONCURRENCY = 8;
  let cursor = 0;
  await Promise.all(
    Array.from({ length: Math.min(SCAN_CONCURRENCY, names.length) }, async () => {
      while (true) {
        const idx = cursor++;
        if (idx >= names.length) break;
        const name = names[idx]!;
        const found = await scanSessionHits(name, needle, ctx, lastUserBySession);
        if (found) rawHits.push(found);
      }
    }),
  );
  // Resolve identity only AFTER the scan, once `lastUserBySession` is complete —
  // otherwise a concurrent worker could resolve a topic before another worker
  // has registered its file.
  const results: SessionHit[] = [];
  for (const raw of rawHits) {
    const identity = await resolveSessionIdentity(
      ctx,
      raw.sessionId,
      raw.fileName,
      identityCache,
      lastUserBySession,
    );
    results.push({
      ...identity,
      workspace: raw.workspace,
      messages: raw.messages,
      hitIndex: raw.hitIndex,
      matchCount: raw.matchCount,
    });
  }
  // Newest hit first, so both the hit groups inside a conversation and the
  // conversation rows themselves come out newest-first.
  results.sort((a, b) => newestHitMs(b) - newestHitMs(a));
  // One OMP session = one conversation: collapse a session's hit groups under a
  // single row; the first (newest) group stays the representative snippet for
  // the detail view.
  const grouped = new Map<string, SearchContext>();
  for (const r of results) {
    const group: SearchHitGroup = {
      messages: r.messages,
      hitIndex: r.hitIndex,
      matchCount: r.matchCount,
    };
    const existing = grouped.get(r.sessionId);
    if (existing) {
      existing.groups.push(group);
      existing.matchCount += r.matchCount;
      continue;
    }
    grouped.set(r.sessionId, {
      // The card's row-identity field still carries the legacy name
      // `sessionId`; its value is the OMP session id (one session = one
      // conversation).
      sessionId: r.sessionId,
      ...(r.title !== undefined ? { title: r.title } : {}),
      ...(r.topic !== undefined ? { topic: r.topic } : {}),
      workspace: r.workspace,
      matchCount: r.matchCount,
      groups: [group],
      messages: r.messages,
      hitIndex: r.hitIndex,
    });
  }
  return [...grouped.values()].slice(0, limit);
}

async function scanSessionHits(
  name: string,
  needle: string,
  ctx: CommandContext,
  lastUserBySession: Map<string, string>,
): Promise<RawHit | undefined> {
  let text: string;
  try {
    text = await readFile(join(getOmpSessionDir(ctx.controls.cfg), name), 'utf8');
  } catch {
    return undefined;
  }
  // Index the file's last user message under its identity (the header session
  // id, or the file name for a headerless file): identity resolution uses it as
  // the unnamed row's topic fallback, sourced here so /search never re-scans the
  // directory via loadSessionSummary.
  const fileScan = scanSessionFile(text);
  const sessionId = fileScan.meta?.id;
  lastUserBySession.set(sessionId ?? name, fileScan.lastUserMessage);
  // Cheap prefilter: skip building hit pairs for files with no keyword.
  if (!text.toLowerCase().includes(needle)) return undefined;

  const workspace = workspaceLabel(ctx, fileScan.meta?.cwd || homedir());

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

  let newest: { messages: SearchHit[]; hitIndex: number } | undefined;
  let matchCount = 0;
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
    matchCount += 1;
    // The stream is chronological, so the last matching pair is the newest one.
    newest = { messages: pair.map((m) => ({ ...m, timestamp: m.timestamp })), hitIndex };
  }
  if (!newest) return undefined;
  return {
    ...(sessionId !== undefined ? { sessionId } : {}),
    fileName: name,
    workspace,
    messages: newest.messages,
    hitIndex: newest.hitIndex,
    matchCount,
  };
}

async function handleSearch(args: string, ctx: CommandContext): Promise<void> {
  const [sub, ...rest] = args.trim().split(/\s+/);

  if (sub === 'page') {
    // 卡片翻页：args = page <queryId> <offset>。cache 未命中则回退为
    // 关键词检索（queryId 是内部格式，正常不会撞词）。
    const queryId = rest[0] ?? '';
    const offset = Number.parseInt(rest[1] ?? '', 10);
    const cached = searchCache.get(queryId);
    const keyword = searchKeywords.get(queryId) ?? '';
    if (cached && Number.isFinite(offset) && offset >= 0) {
      if (ctx.fromCardAction) await recallMessage(ctx, ctx.msg.messageId);
      await sendManagedCard(
        ctx.channel,
        ctx.msg.chatId,
        searchResultsCard(keyword, cached, queryId, true, offset),
      );
      return;
    }
  }

  if (sub === 'resume') {
    // 卡片按钮带目标 sessionId（命中会话）。没有 arg 时保持旧语义：
    // 提示当前会话状态（直接发 `/s resume` 的场景）。
    const targetId = rest.join('').trim();
    if (targetId) {
      const sessions = await listResumableSessions(ctx);
      // The card button carries the target session id.
      const match = sessions.find((s) => s.sessionId === targetId);
      if (!match) {
        await reply(ctx, `❌ 该会话已不存在或无法恢复：\`${targetId}\``);
        return;
      }
      await applyResume(ctx, match);
      return;
    }
    const current = ctx.sessions.sessionFor(ctx.scope);
    if (current === undefined) {
      await reply(ctx, '当前没有可继续的会话。');
      return;
    }
    await applyResume(ctx, { sessionId: current.sessionId, cwd: current.cwd, timestamp: '' });
    return;
  }

  if (sub === 'done') {
    const queryRef = rest.join(' ').trim();
    const [queryId, idxStr] = queryRef.split(/\s+/);
    const contexts = searchCache.get(queryId ?? '');
    // Cache expired (LRU eviction / restart): the detail card can no longer be
    // rebuilt, and its 继续对话 arg would be empty — an empty target must NEVER
    // fall through to resuming the current chat session. Tell the user to
    // search again instead.
    if (contexts === undefined) {
      await reply(ctx, '搜索结果已过期，请重新 `/search`。');
      return;
    }
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
            // workspace / work-session context intact.
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
      await reply(ctx, `🆔 会话: \`${sessionId}\`\n\n${full}`);
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
    if (ctx.fromCardAction) await recallMessage(ctx, ctx.msg.messageId);
    await sendManagedCard(ctx.channel, ctx.msg.chatId, searchEmptyCard(keyword));
    return;
  }
  const queryId = `s${Date.now().toString(36)}`;
  searchCache.set(queryId, contexts);
  searchKeywords.set(queryId, keyword);
  if (searchCache.size > SEARCH_CACHE_MAX) {
    const oldest = searchCache.keys().next().value;
    if (oldest) {
      searchCache.delete(oldest);
      searchKeywords.delete(oldest);
    }
  }
  if (ctx.fromCardAction) await recallMessage(ctx, ctx.msg.messageId);
  await sendManagedCard(
    ctx.channel,
    ctx.msg.chatId,
    searchResultsCard(keyword, contexts, queryId, true),
  );
}
